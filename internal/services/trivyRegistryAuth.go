package services_k8sclient

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Everything in this file handles registry credentials. None of it may log a
// secret's content, and no error may carry it: errors are fixed strings, never
// a wrapped JSON or base64 error (those can quote the input).

const dockerHubHost = "index.docker.io"

var (
	errBadDockerConfig = errors.New("pull secret is not a valid docker config")
	errBadAuthField    = errors.New("pull secret auth field is not base64 user:password")
)

// normaliseRegistryHost reduces a docker config key or a registry name to a
// bare, lower-case host[:port]: no scheme, no path, and every Docker Hub alias
// folded into index.docker.io.
func normaliseRegistryHost(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	s = strings.ToLower(s)
	switch s {
	case "docker.io", "index.docker.io", "registry-1.docker.io":
		return dockerHubHost
	}
	return s
}

// RegistryHost is the normalised registry host an image is pulled from, or ""
// when the reference does not parse.
func RegistryHost(image string) string {
	ref, err := name.ParseReference(image, name.WeakValidation)
	if err != nil {
		return ""
	}
	return normaliseRegistryHost(ref.Context().RegistryStr())
}

type dockerConfigEntry struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Auth     string `json:"auth"`
}

// CredentialForRegistry returns the credential a kubernetes.io/dockerconfigjson
// payload holds for host, or nil, nil when it has none.
func CredentialForRegistry(dockerConfigJSON []byte, host string) (*RegistryCredential, error) {
	var cfg struct {
		Auths map[string]dockerConfigEntry `json:"auths"`
	}
	if err := json.Unmarshal(dockerConfigJSON, &cfg); err != nil {
		return nil, errBadDockerConfig
	}
	return credentialFromEntries(cfg.Auths, host)
}

// credentialForDockercfg is CredentialForRegistry for the legacy
// kubernetes.io/dockercfg payload, which has no "auths" wrapper.
func credentialForDockercfg(dockercfg []byte, host string) (*RegistryCredential, error) {
	var entries map[string]dockerConfigEntry
	if err := json.Unmarshal(dockercfg, &entries); err != nil {
		return nil, errBadDockerConfig
	}
	return credentialFromEntries(entries, host)
}

// credentialFromEntries picks the first usable entry (in key order, so the
// choice is stable) whose key normalises to host. Entries without a username
// and password (e.g. identitytoken only) are skipped.
func credentialFromEntries(entries map[string]dockerConfigEntry, host string) (*RegistryCredential, error) {
	host = normaliseRegistryHost(host)
	if host == "" {
		return nil, nil
	}
	keys := make([]string, 0, len(entries))
	for k := range entries {
		if normaliseRegistryHost(k) == host {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	// A broken entry does not hide a usable alias of the same host; its error
	// is reported only when no entry for the host yields a credential.
	var firstErr error
	for _, k := range keys {
		cred, err := entryCredential(entries[k])
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if cred != nil {
			return cred, nil
		}
	}
	return nil, firstErr
}

// entryCredential prefers a complete username/password pair over the auth
// field (base64 "user:pass", split on the first ':'), and treats an entry that
// yields an empty username and password as no credential.
func entryCredential(e dockerConfigEntry) (*RegistryCredential, error) {
	user, pass := e.Username, e.Password
	if (user == "" || pass == "") && e.Auth != "" {
		raw, err := base64.StdEncoding.DecodeString(e.Auth)
		if err != nil {
			return nil, errBadAuthField
		}
		u, p, ok := strings.Cut(string(raw), ":")
		if !ok {
			return nil, errBadAuthField
		}
		user, pass = u, p
	}
	if user == "" && pass == "" {
		return nil, nil
	}
	return &RegistryCredential{Username: user, Password: pass}, nil
}

// ResolvePullCredential finds the credential for t's registry among its pull
// secrets, tried in order. It returns the credential and the secret's
// "ns/name"; when none matched and at least one secret could not be read for
// lack of permission, the reason is "pullSecretForbidden". Missing secrets and
// secrets that do not parse are skipped.
func ResolvePullCredential(ctx context.Context, client kubernetes.Interface, t ScanTarget) (cred *RegistryCredential, secret string, reason string) {
	host := RegistryHost(t.Image)
	if host == "" {
		return nil, "", ""
	}
	forbidden := false
	for _, ref := range t.PullSecrets {
		s, err := client.CoreV1().Secrets(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			if apierrors.IsForbidden(err) {
				forbidden = true
			}
			continue
		}
		var c *RegistryCredential
		switch s.Type {
		case corev1.SecretTypeDockerConfigJson:
			c, err = CredentialForRegistry(s.Data[corev1.DockerConfigJsonKey], host)
		case corev1.SecretTypeDockercfg:
			c, err = credentialForDockercfg(s.Data[corev1.DockerConfigKey], host)
		default:
			continue
		}
		if err != nil || c == nil {
			continue
		}
		return c, ref.Namespace + "/" + ref.Name, ""
	}
	if forbidden {
		return nil, "", "pullSecretForbidden"
	}
	return nil, "", ""
}

// saPullSecrets caches each namespace's ServiceAccount pull secrets, listed
// once per namespace. A namespace whose ServiceAccounts cannot be listed
// (Forbidden, ...) contributes none.
type saPullSecrets struct {
	client kubernetes.Interface
	byNS   map[string]map[string][]corev1.LocalObjectReference
}

func (c *saPullSecrets) lookup(ctx context.Context, ns, sa string) []corev1.LocalObjectReference {
	m, ok := c.byNS[ns]
	if !ok {
		m = map[string][]corev1.LocalObjectReference{}
		if list, err := c.client.CoreV1().ServiceAccounts(ns).List(ctx, metav1.ListOptions{}); err == nil {
			for _, s := range list.Items {
				m[s.Name] = s.ImagePullSecrets
			}
		}
		c.byNS[ns] = m
	}
	return m[sa]
}

// podPullSecrets lists a pod's pull secret names: its own imagePullSecrets in
// order, then its ServiceAccount's ("default" when unset).
func podPullSecrets(ctx context.Context, pod *corev1.Pod, sas *saPullSecrets) []PullSecretRef {
	sa := pod.Spec.ServiceAccountName
	if sa == "" {
		sa = "default"
	}
	refs := append(append([]corev1.LocalObjectReference{}, pod.Spec.ImagePullSecrets...), sas.lookup(ctx, pod.Namespace, sa)...)
	out := make([]PullSecretRef, 0, len(refs))
	for _, r := range refs {
		if r.Name != "" {
			out = append(out, PullSecretRef{Namespace: pod.Namespace, Name: r.Name})
		}
	}
	return out
}
