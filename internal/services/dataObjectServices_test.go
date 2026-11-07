package services_k8sclient

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"testing"
	"time"

	"kube-ins/internal/models"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func entryMap(entries []models.DataEntry) map[string]models.DataEntry {
	m := map[string]models.DataEntry{}
	for _, e := range entries {
		m[e.Key] = e
	}
	return m
}

func TestSaveSecretKeepsBinaryValueByteForByte(t *testing.T) {
	keystore := []byte{0xfe, 0xed, 0xfe, 0xed, 0x00, 0x80, 0xff}
	client := fake.NewSimpleClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "s", Namespace: "ns", ResourceVersion: "1"},
		Data:       map[string][]byte{"keystore.jks": keystore, "user": []byte("admin")},
	})

	obj, err := GetDataObject("Secret", "ns", "s", client)
	if err != nil {
		t.Fatal(err)
	}
	got := entryMap(obj.Entries)
	if !got["keystore.jks"].Binary || got["user"].Binary {
		t.Fatalf("binary flags wrong: %+v", obj.Entries)
	}

	// Edit only the text key and send everything back, as the editor does.
	entries := []models.DataEntry{got["keystore.jks"], {Key: "user", Value: b64("root")}}
	if _, err := SaveDataObject("Secret", "ns", "s", obj.ResourceVersion, entries, false, client); err != nil {
		t.Fatal(err)
	}
	s, _ := client.CoreV1().Secrets("ns").Get(context.Background(), "s", metav1.GetOptions{})
	if !bytes.Equal(s.Data["keystore.jks"], keystore) {
		t.Fatalf("binary value changed: %v", s.Data["keystore.jks"])
	}
	if string(s.Data["user"]) != "root" {
		t.Fatalf("user = %q", s.Data["user"])
	}
}

func TestSaveRefusesAStaleResourceVersion(t *testing.T) {
	client := fake.NewSimpleClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "c", Namespace: "ns", ResourceVersion: "7"},
		Data:       map[string]string{"a": "1"},
	})
	_, err := SaveDataObject("ConfigMap", "ns", "c", "6", []models.DataEntry{{Key: "a", Value: b64("2")}}, false, client)
	if !errors.Is(err, ErrDataConflict) {
		t.Fatalf("err = %v, want conflict", err)
	}
	cm, _ := client.CoreV1().ConfigMaps("ns").Get(context.Background(), "c", metav1.GetOptions{})
	if cm.Data["a"] != "1" {
		t.Fatalf("stale save went through: %v", cm.Data)
	}
}

func TestSaveConfigMapSplitsDataAndBinaryData(t *testing.T) {
	client := fake.NewSimpleClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "c", Namespace: "ns", ResourceVersion: "1"},
		Data:       map[string]string{"old": "x"},
		BinaryData: map[string][]byte{"logo.png": {0x89, 0x50}},
	})
	obj, err := GetDataObject("ConfigMap", "ns", "c", client)
	if err != nil {
		t.Fatal(err)
	}
	if e := entryMap(obj.Entries)["logo.png"]; !e.Binary {
		t.Fatalf("binaryData key not marked binary: %+v", e)
	}
	entries := []models.DataEntry{
		entryMap(obj.Entries)["logo.png"],
		{Key: "app.yaml", Value: b64("port: 8080\n")},
		// Not UTF-8 and not marked: still has to land in binaryData.
		{Key: "raw.bin", Value: base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe})},
	}
	if _, err := SaveDataObject("ConfigMap", "ns", "c", "1", entries, false, client); err != nil {
		t.Fatal(err)
	}
	cm, _ := client.CoreV1().ConfigMaps("ns").Get(context.Background(), "c", metav1.GetOptions{})
	if _, ok := cm.Data["old"]; ok {
		t.Fatal("removed key still present")
	}
	if cm.Data["app.yaml"] != "port: 8080\n" {
		t.Fatalf("data = %v", cm.Data)
	}
	if len(cm.BinaryData["logo.png"]) != 2 || len(cm.BinaryData["raw.bin"]) != 2 {
		t.Fatalf("binaryData = %v", cm.BinaryData)
	}
}

func TestSaveValidatesKeysAndImmutability(t *testing.T) {
	yes := true
	client := fake.NewSimpleClientset(
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "c", Namespace: "ns"}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "locked", Namespace: "ns"}, Immutable: &yes},
	)
	cases := map[string][]models.DataEntry{
		"bad key":   {{Key: "has space", Value: b64("x")}},
		"empty key": {{Key: "", Value: b64("x")}},
		"duplicate": {{Key: "a", Value: b64("1")}, {Key: "a", Value: b64("2"), Binary: true}},
		"not b64":   {{Key: "a", Value: "%%%"}},
	}
	for name, entries := range cases {
		if _, err := SaveDataObject("ConfigMap", "ns", "c", "", entries, false, client); !errors.Is(err, ErrDataInvalid) {
			t.Errorf("%s: err = %v, want invalid", name, err)
		}
	}
	if _, err := SaveDataObject("Secret", "ns", "locked", "", []models.DataEntry{{Key: "a", Value: b64("1")}}, false, client); !errors.Is(err, ErrDataImmutable) {
		t.Errorf("immutable: err = %v", err)
	}
}

func TestGetDataConsumersGroupsAndFlagsRestart(t *testing.T) {
	ctrl := true
	rs := &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "api-5d", Namespace: "ns",
		OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "api", Controller: &ctrl}}}}
	owned := func(name string, spec corev1.PodSpec) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ns",
			OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "api-5d", Controller: &ctrl}}}, Spec: spec}
	}
	envSpec := corev1.PodSpec{Containers: []corev1.Container{{Name: "c",
		EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "cfg"}}}}}}}
	volSpec := corev1.PodSpec{
		Volumes:    []corev1.Volume{{Name: "v", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "cfg"}}}}},
		Containers: []corev1.Container{{Name: "c", VolumeMounts: []corev1.VolumeMount{{Name: "v", MountPath: "/etc/app"}}}},
	}
	subPathSpec := corev1.PodSpec{
		Volumes:    volSpec.Volumes,
		Containers: []corev1.Container{{Name: "c", VolumeMounts: []corev1.VolumeMount{{Name: "v", MountPath: "/etc/nginx/nginx.conf", SubPath: "nginx.conf"}}}},
	}
	other := corev1.PodSpec{Containers: []corev1.Container{{Name: "c"}}}

	client := fake.NewSimpleClientset(rs,
		owned("api-1", envSpec), owned("api-2", envSpec),
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "vol", Namespace: "ns"}, Spec: volSpec},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "sub", Namespace: "ns"}, Spec: subPathSpec},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "unrelated", Namespace: "ns"}, Spec: other},
	)
	got, err := GetDataConsumers("ConfigMap", "ns", "cfg", client)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("consumers = %+v", got)
	}
	byName := map[string]models.DataConsumer{}
	for _, c := range got {
		byName[c.Kind+"/"+c.Name] = c
	}
	if d := byName["Deployment/api"]; d.Pods != 2 || !d.NeedsRestart || len(d.Usages) != 1 || d.Usages[0] != "envFrom" {
		t.Errorf("deployment = %+v", d)
	}
	if v := byName["Pod/vol"]; v.NeedsRestart || v.Usages[0] != "/etc/app" {
		t.Errorf("volume pod = %+v", v)
	}
	if s := byName["Pod/sub"]; !s.NeedsRestart {
		t.Errorf("subPath pod = %+v", s)
	}
}

func testCertPair(t *testing.T) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "app.example.com"},
		DNSNames:     []string{"app.example.com"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb})
}

func TestInspectTlsPair(t *testing.T) {
	cert, key := testCertPair(t)
	enc := base64.StdEncoding.EncodeToString

	info := InspectTlsPair(enc(cert), enc(key))
	if info.Error != "" || !info.KeyMatches || info.DNSNames[0] != "app.example.com" || info.NotAfter == "" {
		t.Fatalf("good pair: %+v", info)
	}

	_, otherKey := testCertPair(t)
	if info := InspectTlsPair(enc(cert), enc(otherKey)); info.KeyMatches || info.KeyError == "" || info.Subject == "" {
		t.Fatalf("mismatched key: %+v", info)
	}

	if info := InspectTlsPair(b64("not a cert"), ""); info.Error == "" {
		t.Fatalf("bad PEM: %+v", info)
	}
}
