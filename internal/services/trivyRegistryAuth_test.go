package services_k8sclient

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestRegistryHost(t *testing.T) {
	cases := map[string]string{
		"nginx":                     "index.docker.io",
		"docker.io/library/nginx":   "index.docker.io",
		"localhost:5000/a:1":        "localhost:5000",
		"ghcr.io/a/b@sha256:" + sha: "ghcr.io",
		"GHCR.io/a/b:1":             "ghcr.io",
		"::not an image::":          "",
	}
	for in, want := range cases {
		if got := RegistryHost(in); got != want {
			t.Errorf("RegistryHost(%q) = %q, want %q", in, got, want)
		}
	}
}

const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestCredentialForRegistryAuthField(t *testing.T) {
	cfg := []byte(`{"auths":{"ghcr.io":{"auth":"` + b64("u:p:with:colons") + `"}}}`)
	got, err := CredentialForRegistry(cfg, "ghcr.io")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Username != "u" || got.Password != "p:with:colons" {
		t.Fatalf("cred = %+v", got)
	}
}

func TestCredentialForRegistryUserPass(t *testing.T) {
	cfg := []byte(`{"auths":{"https://index.docker.io/v1/":{"username":"u","password":"p","auth":"` + b64("x:y") + `"}}}`)
	got, err := CredentialForRegistry(cfg, "index.docker.io")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Username != "u" || got.Password != "p" {
		t.Fatalf("cred = %+v", got)
	}
}

func TestCredentialForRegistryNoCrossHost(t *testing.T) {
	cfg := []byte(`{"auths":{"ghcr.io":{"auth":"` + b64("u:p") + `"}}}`)
	got, err := CredentialForRegistry(cfg, "quay.io")
	if err != nil || got != nil {
		t.Fatalf("cred = %+v, err = %v; want nil, nil", got, err)
	}
	// A prefix of the host is not the host.
	got, err = CredentialForRegistry([]byte(`{"auths":{"ghcr.io.evil.com":{"auth":"`+b64("u:p")+`"}}}`), "ghcr.io")
	if err != nil || got != nil {
		t.Fatalf("prefix host matched: %+v, %v", got, err)
	}
}

func TestCredentialForRegistrySchemeAndPath(t *testing.T) {
	cfg := []byte(`{"auths":{"https://Registry.Example.com:5000/v2/":{"username":"u","password":"p"}}}`)
	got, err := CredentialForRegistry(cfg, "registry.example.com:5000")
	if err != nil || got == nil || got.Username != "u" {
		t.Fatalf("cred = %+v, err = %v", got, err)
	}
}

func TestCredentialForRegistryEmptyAndToken(t *testing.T) {
	cfg := []byte(`{"auths":{"ghcr.io":{"identitytoken":"tok"},"quay.io":{"auth":"` + b64(":") + `"}}}`)
	for _, h := range []string{"ghcr.io", "quay.io"} {
		got, err := CredentialForRegistry(cfg, h)
		if err != nil || got != nil {
			t.Errorf("%s: cred = %+v, err = %v; want nil, nil", h, got, err)
		}
	}
}

func TestCredentialForRegistryErrorDoesNotEcho(t *testing.T) {
	secret := "s3cr3t-value"
	_, err := CredentialForRegistry([]byte(`{"auths":{"ghcr.io":{"auth":"`+secret+`"}}}`), "ghcr.io")
	if err == nil {
		t.Fatal("want error for undecodable auth")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error echoes secret: %v", err)
	}
	_, err = CredentialForRegistry([]byte(`{"auths": "`+secret), "ghcr.io")
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("bad JSON error = %v", err)
	}
}

func TestListScanTargetsCollectsPullSecrets(t *testing.T) {
	p := tpod("shop", "web", nil, nil, "ghcr.io/shop/web:1")
	p.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "regcred"}}
	p.Spec.ServiceAccountName = "builder"
	p2 := tpod("shop", "web2", nil, nil, "ghcr.io/shop/web:1")
	// Uses the "default" ServiceAccount, which does not exist; regcred again is deduped.
	p2.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "regcred"}}
	sa := &corev1.ServiceAccount{
		ObjectMeta:       metav1.ObjectMeta{Namespace: "shop", Name: "builder"},
		ImagePullSecrets: []corev1.LocalObjectReference{{Name: "sa-cred"}},
	}
	client := fake.NewSimpleClientset(p, p2, sa)
	targets, _, err := ListScanTargets(context.Background(), client, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []PullSecretRef{{"shop", "regcred"}, {"shop", "sa-cred"}}
	if len(targets) != 1 || len(targets[0].PullSecrets) != 2 ||
		targets[0].PullSecrets[0] != want[0] || targets[0].PullSecrets[1] != want[1] {
		t.Fatalf("PullSecrets = %+v, want %+v", targets, want)
	}
}

func TestListScanTargetsServiceAccountForbidden(t *testing.T) {
	p := tpod("shop", "web", nil, nil, "nginx:1")
	p.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "regcred"}}
	client := fake.NewSimpleClientset(p)
	client.PrependReactor("list", "serviceaccounts", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "serviceaccounts"}, "", nil)
	})
	targets, _, err := ListScanTargets(context.Background(), client, "")
	if err != nil {
		t.Fatalf("SA Forbidden failed the listing: %v", err)
	}
	if len(targets) != 1 || len(targets[0].PullSecrets) != 1 || targets[0].PullSecrets[0].Name != "regcred" {
		t.Fatalf("targets = %+v", targets)
	}
}

func pullSecret(ns, name string, typ corev1.SecretType, key string, val []byte) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Type:       typ,
		Data:       map[string][]byte{key: val},
	}
}

func TestResolvePullCredentialForbidden(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("get", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "regcred", nil)
	})
	tgt := ScanTarget{Image: "ghcr.io/shop/web:1", PullSecrets: []PullSecretRef{{"shop", "regcred"}}}
	cred, secret, reason := ResolvePullCredential(context.Background(), client, tgt)
	if cred != nil || secret != "" || reason != "pullSecretForbidden" {
		t.Fatalf("got %+v %q %q", cred, secret, reason)
	}
}

func TestResolvePullCredentialPicksMatchingHost(t *testing.T) {
	client := fake.NewSimpleClientset(
		pullSecret("shop", "quay", corev1.SecretTypeDockerConfigJson, corev1.DockerConfigJsonKey,
			[]byte(`{"auths":{"quay.io":{"auth":"`+b64("q:q")+`"}}}`)),
		pullSecret("shop", "legacy", corev1.SecretTypeDockercfg, corev1.DockerConfigKey,
			[]byte(`{"https://ghcr.io":{"auth":"`+b64("g:pw")+`"}}`)),
	)
	tgt := ScanTarget{Image: "ghcr.io/shop/web:1", PullSecrets: []PullSecretRef{{"shop", "missing"}, {"shop", "quay"}, {"shop", "legacy"}}}
	cred, secret, reason := ResolvePullCredential(context.Background(), client, tgt)
	if cred == nil || cred.Username != "g" || cred.Password != "pw" || secret != "shop/legacy" || reason != "" {
		t.Fatalf("got %+v %q %q", cred, secret, reason)
	}
}

func TestResolvePullCredentialNoneMatch(t *testing.T) {
	client := fake.NewSimpleClientset(
		pullSecret("shop", "quay", corev1.SecretTypeDockerConfigJson, corev1.DockerConfigJsonKey,
			[]byte(`{"auths":{"quay.io":{"auth":"`+b64("q:q")+`"}}}`)),
	)
	tgt := ScanTarget{Image: "nginx:1", PullSecrets: []PullSecretRef{{"shop", "quay"}, {"shop", "gone"}}}
	cred, secret, reason := ResolvePullCredential(context.Background(), client, tgt)
	if cred != nil || secret != "" || reason != "" {
		t.Fatalf("got %+v %q %q", cred, secret, reason)
	}
}

func TestCredentialForRegistryPartialFieldsFallBackToAuth(t *testing.T) {
	// A username without a password is not a usable pair; the auth field is.
	cfg := []byte(`{"auths":{"ghcr.io":{"username":"u","auth":"` + b64("u:p") + `"}}}`)
	got, err := CredentialForRegistry(cfg, "ghcr.io")
	if err != nil || got == nil || got.Username != "u" || got.Password != "p" {
		t.Fatalf("cred = %+v, err = %v", got, err)
	}
}

func TestCredentialForRegistryBadAliasDoesNotHideGoodOne(t *testing.T) {
	// "docker.io" sorts before "https://index.docker.io/v1/"; its broken auth
	// must not hide the usable entry for the same host.
	cfg := []byte(`{"auths":{"docker.io":{"auth":"!!"},"https://index.docker.io/v1/":{"auth":"` + b64("u:p") + `"}}}`)
	got, err := CredentialForRegistry(cfg, "index.docker.io")
	if err != nil || got == nil || got.Username != "u" || got.Password != "p" {
		t.Fatalf("cred = %+v, err = %v", got, err)
	}
}

func TestNormaliseRegistryHost(t *testing.T) {
	cases := map[string]string{
		"https://index.docker.io/v1/": "index.docker.io",
		"registry-1.docker.io":        "index.docker.io",
		"HTTP://Quay.io/":             "quay.io",
		"ghcr.io/":                    "ghcr.io",
		// Only a leading scheme is stripped: a "://" after the first "/" is
		// part of the path, so this key belongs to evil.com.
		"evil.com/x://ghcr.io": "evil.com",
	}
	for in, want := range cases {
		if got := normaliseRegistryHost(in); got != want {
			t.Errorf("normaliseRegistryHost(%q) = %q, want %q", in, got, want)
		}
	}
	got, err := CredentialForRegistry([]byte(`{"auths":{"evil.com/x://ghcr.io":{"auth":"`+b64("u:p")+`"}}}`), "ghcr.io")
	if err != nil || got != nil {
		t.Fatalf("path-embedded scheme matched ghcr.io: %+v, %v", got, err)
	}
}
