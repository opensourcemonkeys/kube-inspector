// Package certs gives the webhook server its TLS identity without depending on
// cert-manager: a self-signed CA and a serving certificate kept in a Secret,
// and the CA kept in the ValidatingWebhookConfiguration's caBundle.
//
// The CA is long-lived and only created once on purpose. The audit webhook's
// kubeconfig on the control-plane nodes embeds it, and rotating it would
// silently cut the audit feed until someone edited files on those nodes. The
// serving certificate is reissued from the same CA whenever its names change
// or it nears expiry.
package certs

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"slices"
	"sync/atomic"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const (
	caValidity    = 20 * 365 * 24 * time.Hour
	leafValidity  = 2 * 365 * 24 * time.Hour
	renewBefore   = 30 * 24 * time.Hour
	keyCACert     = "ca.crt"
	keyCAKey      = "ca.key"
	keyLeafCert   = corev1.TLSCertKey
	keyLeafKey    = corev1.TLSPrivateKeyKey
	syncCAEvery   = 30 * time.Second
	managedByNote = "toolbox"
)

type Manager struct {
	Client      kubernetes.Interface
	Namespace   string
	SecretName  string
	ServiceName string
	ExtraSANs   []string
	WebhookName string

	cert atomic.Pointer[tls.Certificate]
	ca   atomic.Pointer[[]byte]
}

// DNSNames are the names the serving certificate must cover.
func (m *Manager) DNSNames() []string {
	s, ns := m.ServiceName, m.Namespace
	return []string{s, s + "." + ns, s + "." + ns + ".svc", s + "." + ns + ".svc.cluster.local"}
}

// Ensure loads the Secret, creating or reissuing what is missing, and makes
// the result available to GetCertificate. Replicas starting together race on
// the Secret; the loser of a create or update re-reads and uses the winner's.
func (m *Manager) Ensure(ctx context.Context) error {
	for attempt := 0; attempt < 5; attempt++ {
		err := m.ensureOnce(ctx)
		if err == nil {
			return nil
		}
		if !apierrors.IsAlreadyExists(err) && !apierrors.IsConflict(err) {
			return err
		}
	}
	return errors.New("certs: gave up after repeated conflicts on the TLS secret")
}

func (m *Manager) ensureOnce(ctx context.Context) error {
	secrets := m.Client.CoreV1().Secrets(m.Namespace)
	sec, err := secrets.Get(ctx, m.SecretName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		sec = &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: m.SecretName, Namespace: m.Namespace,
				Labels: map[string]string{"app.kubernetes.io/managed-by": managedByNote}},
			Type: corev1.SecretTypeOpaque,
			Data: map[string][]byte{},
		}
		if err := m.fill(sec.Data); err != nil {
			return err
		}
		if _, err := secrets.Create(ctx, sec, metav1.CreateOptions{}); err != nil {
			return err
		}
		slog.Info("created webhook TLS secret", "secret", m.SecretName)
		return m.load(sec.Data)
	}
	if err != nil {
		return err
	}
	if sec.Data == nil {
		sec.Data = map[string][]byte{}
	}
	if m.valid(sec.Data) {
		return m.load(sec.Data)
	}
	if err := m.fill(sec.Data); err != nil {
		return err
	}
	if _, err := secrets.Update(ctx, sec, metav1.UpdateOptions{}); err != nil {
		return err
	}
	slog.Info("reissued webhook serving certificate", "secret", m.SecretName)
	return m.load(sec.Data)
}

// fill creates the CA if the data has none and (re)issues the serving cert.
func (m *Manager) fill(data map[string][]byte) error {
	caCert, caKey, err := parseCA(data)
	if err != nil {
		caCert, caKey, err = newCA()
		if err != nil {
			return err
		}
		data[keyCACert] = pemCert(caCert.Raw)
		data[keyCAKey], err = pemKey(caKey)
		if err != nil {
			return err
		}
	}
	certDER, key, err := m.newLeaf(caCert, caKey)
	if err != nil {
		return err
	}
	data[keyLeafCert] = pemCert(certDER)
	data[keyLeafKey], err = pemKey(key)
	return err
}

func (m *Manager) valid(data map[string][]byte) bool {
	if _, _, err := parseCA(data); err != nil {
		return false
	}
	pair, err := tls.X509KeyPair(data[keyLeafCert], data[keyLeafKey])
	if err != nil {
		return false
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil || time.Until(leaf.NotAfter) < renewBefore {
		return false
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(data[keyCACert])
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool}); err != nil {
		return false
	}
	dns, ips := m.sans()
	for _, d := range dns {
		if !slices.Contains(leaf.DNSNames, d) {
			return false
		}
	}
	for _, ip := range ips {
		if !slices.ContainsFunc(leaf.IPAddresses, ip.Equal) {
			return false
		}
	}
	return true
}

func (m *Manager) load(data map[string][]byte) error {
	pair, err := tls.X509KeyPair(data[keyLeafCert], data[keyLeafKey])
	if err != nil {
		return err
	}
	ca := bytes.Clone(data[keyCACert])
	m.cert.Store(&pair)
	m.ca.Store(&ca)
	return nil
}

// GetCertificate is the tls.Config hook for the webhook server.
func (m *Manager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c := m.cert.Load()
	if c == nil {
		return nil, errors.New("certificate not loaded")
	}
	return c, nil
}

// CABundle is the PEM CA the API server must trust to call us.
func (m *Manager) CABundle() []byte {
	if p := m.ca.Load(); p != nil {
		return *p
	}
	return nil
}

// KeepCABundle patches the ValidatingWebhookConfiguration's caBundle until ctx
// ends. It loops rather than patching once because a `helm upgrade` re-applies
// the configuration from the chart and may reset the bundle; until it is put
// back, every admission call fails TLS (harmlessly — failurePolicy is Ignore —
// but unattributed).
func (m *Manager) KeepCABundle(ctx context.Context) {
	if m.WebhookName == "" {
		return
	}
	t := time.NewTicker(syncCAEvery)
	defer t.Stop()
	for {
		if err := m.syncCABundle(ctx); err != nil && !apierrors.IsNotFound(err) {
			slog.Warn("webhook caBundle sync failed", "webhook", m.WebhookName, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (m *Manager) syncCABundle(ctx context.Context) error {
	ca := m.CABundle()
	if ca == nil {
		return nil
	}
	api := m.Client.AdmissionregistrationV1().ValidatingWebhookConfigurations()
	cfg, err := api.Get(ctx, m.WebhookName, metav1.GetOptions{})
	if err != nil {
		return err
	}
	changed := false
	for i := range cfg.Webhooks {
		if !bytes.Equal(cfg.Webhooks[i].ClientConfig.CABundle, ca) {
			cfg.Webhooks[i].ClientConfig.CABundle = ca
			changed = true
		}
	}
	if !changed {
		return nil
	}
	if _, err := api.Update(ctx, cfg, metav1.UpdateOptions{}); err != nil {
		return err
	}
	slog.Info("webhook caBundle updated", "webhook", m.WebhookName)
	return nil
}

func (m *Manager) sans() ([]string, []net.IP) {
	dns := m.DNSNames()
	var ips []net.IP
	for _, s := range m.ExtraSANs {
		if ip := net.ParseIP(s); ip != nil {
			ips = append(ips, ip)
		} else if s != "" {
			dns = append(dns, s)
		}
	}
	return dns, ips
}

func newCA() (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "toolbox-webhook-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(caValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	return cert, key, err
}

func (m *Manager) newLeaf(ca *x509.Certificate, caKey *ecdsa.PrivateKey) ([]byte, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	dns, ips := m.sans()
	tmpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: dns[2]},
		DNSNames:     dns,
		IPAddresses:  ips,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(leafValidity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	return der, key, err
}

func parseCA(data map[string][]byte) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	cb, _ := pem.Decode(data[keyCACert])
	kb, _ := pem.Decode(data[keyCAKey])
	if cb == nil || kb == nil {
		return nil, nil, errors.New("no CA")
	}
	cert, err := x509.ParseCertificate(cb.Bytes)
	if err != nil {
		return nil, nil, err
	}
	key, err := x509.ParseECPrivateKey(kb.Bytes)
	if err != nil {
		return nil, nil, err
	}
	if time.Now().After(cert.NotAfter) {
		return nil, nil, fmt.Errorf("CA expired on %s", cert.NotAfter)
	}
	return cert, key, nil
}

func serial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	return n
}

func pemCert(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func pemKey(k *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), nil
}
