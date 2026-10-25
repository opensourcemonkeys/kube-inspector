package certs

import (
	"bytes"
	"context"
	"crypto/x509"
	"testing"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestEnsureCreatesThenReusesAndKeepsCA(t *testing.T) {
	ctx := context.Background()
	client := fake.NewClientset(&admissionregistrationv1.ValidatingWebhookConfiguration{
		ObjectMeta: metav1.ObjectMeta{Name: "toolbox"},
		Webhooks:   []admissionregistrationv1.ValidatingWebhook{{Name: "a.toolbox.io"}, {Name: "b.toolbox.io"}},
	})
	m := &Manager{Client: client, Namespace: "obs", SecretName: "toolbox-tls", ServiceName: "toolbox", WebhookName: "toolbox"}
	if err := m.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	ca1 := m.CABundle()
	leaf1, _ := m.GetCertificate(nil)

	// A second replica reads the same secret and gets the same certificate.
	m2 := &Manager{Client: client, Namespace: "obs", SecretName: "toolbox-tls", ServiceName: "toolbox"}
	if err := m2.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	leaf2, _ := m2.GetCertificate(nil)
	if !bytes.Equal(leaf1.Certificate[0], leaf2.Certificate[0]) {
		t.Fatal("second replica reissued an already valid certificate")
	}

	// Adding a SAN reissues the leaf from the same CA.
	m3 := &Manager{Client: client, Namespace: "obs", SecretName: "toolbox-tls", ServiceName: "toolbox",
		ExtraSANs: []string{"10.96.200.200", "audit.example"}}
	if err := m3.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(m3.CABundle(), ca1) {
		t.Fatal("CA rotated; that would break the audit kubeconfig on the control plane")
	}
	leaf3, _ := m3.GetCertificate(nil)
	cert, _ := x509.ParseCertificate(leaf3.Certificate[0])
	if len(cert.IPAddresses) != 1 || cert.IPAddresses[0].String() != "10.96.200.200" {
		t.Fatalf("IP SAN missing: %v", cert.IPAddresses)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(ca1)
	if _, err := cert.Verify(x509.VerifyOptions{Roots: pool, DNSName: "toolbox.obs.svc"}); err != nil {
		t.Fatal(err)
	}

	if err := m.syncCABundle(ctx); err != nil {
		t.Fatal(err)
	}
	vwc, _ := client.AdmissionregistrationV1().ValidatingWebhookConfigurations().Get(ctx, "toolbox", metav1.GetOptions{})
	for _, w := range vwc.Webhooks {
		if !bytes.Equal(w.ClientConfig.CABundle, ca1) {
			t.Fatalf("webhook %s caBundle not synced", w.Name)
		}
	}
}
