package services_k8sclient

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"kube-ins/internal/models"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
)

// The key/value editor's save outcomes. The business layer turns them into
// DataSaveResult codes, so the frontend never has to match error text.
var (
	ErrDataConflict  = errors.New("the object changed since it was loaded")
	ErrDataImmutable = errors.New("the object is immutable")
	ErrDataInvalid   = errors.New("invalid data")
)

const (
	dataKindConfigMap = "ConfigMap"
	dataKindSecret    = "Secret"
	dataTimeout       = 20 * time.Second
)

// GetDataObject reads a ConfigMap or Secret for the key/value editor. Values
// are base64 so binary data survives JSON: a Secret used to come back as
// string(bytes), which JSON turned into U+FFFD for anything not UTF-8, and the
// next save wrote that back over every key.
func GetDataObject(kind, namespace, name string, client kubernetes.Interface) (models.DataObject, error) {
	if namespace == "" || name == "" {
		return models.DataObject{}, errNamespaceNameRequired
	}
	ctx, cancel := context.WithTimeout(context.Background(), dataTimeout)
	defer cancel()

	obj := models.DataObject{Kind: kind, Name: name, Namespace: namespace, Entries: []models.DataEntry{}}
	switch kind {
	case dataKindConfigMap:
		cm, err := client.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return obj, err
		}
		obj.ResourceVersion = cm.ResourceVersion
		obj.Immutable = cm.Immutable != nil && *cm.Immutable
		for k, v := range cm.Data {
			obj.Entries = append(obj.Entries, models.DataEntry{Key: k, Value: base64.StdEncoding.EncodeToString([]byte(v))})
		}
		for k, v := range cm.BinaryData {
			obj.Entries = append(obj.Entries, models.DataEntry{Key: k, Value: base64.StdEncoding.EncodeToString(v), Binary: true})
		}
	case dataKindSecret:
		s, err := client.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return obj, err
		}
		obj.ResourceVersion = s.ResourceVersion
		obj.Immutable = s.Immutable != nil && *s.Immutable
		obj.Type = string(s.Type)
		for k, v := range s.Data {
			obj.Entries = append(obj.Entries, models.DataEntry{Key: k, Value: base64.StdEncoding.EncodeToString(v), Binary: !utf8.Valid(v)})
		}
	default:
		return obj, fmt.Errorf("unsupported kind %q", kind)
	}
	sort.Slice(obj.Entries, func(i, j int) bool { return obj.Entries[i].Key < obj.Entries[j].Key })
	return obj, nil
}

// SaveDataObject replaces the object's data with entries. resourceVersion is
// the one the editor loaded: a different live version means someone else
// changed the object in the meantime, and saving over it would silently undo
// their change. The API server enforces the same through Update, but the
// explicit check also covers clients that do not (the fake one in tests).
func SaveDataObject(kind, namespace, name, resourceVersion string, entries []models.DataEntry, dryRun bool, client kubernetes.Interface) (string, error) {
	if namespace == "" || name == "" {
		return "", errNamespaceNameRequired
	}
	data, binary, err := decodeEntries(kind, entries)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dataTimeout)
	defer cancel()
	opts := metav1.UpdateOptions{}
	if dryRun {
		opts.DryRun = []string{metav1.DryRunAll}
	}

	switch kind {
	case dataKindConfigMap:
		cm, err := client.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return "", err
		}
		if err := checkWritable(cm.ResourceVersion, resourceVersion, cm.Immutable); err != nil {
			return "", err
		}
		cm.Data, cm.BinaryData = map[string]string{}, map[string][]byte{}
		for k, v := range data {
			cm.Data[k] = string(v)
		}
		for k, v := range binary {
			cm.BinaryData[k] = v
		}
		out, err := client.CoreV1().ConfigMaps(namespace).Update(ctx, cm, opts)
		if err != nil {
			return "", saveError(err)
		}
		return out.ResourceVersion, nil
	case dataKindSecret:
		s, err := client.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return "", err
		}
		if err := checkWritable(s.ResourceVersion, resourceVersion, s.Immutable); err != nil {
			return "", err
		}
		s.Data = map[string][]byte{}
		for k, v := range data {
			s.Data[k] = v
		}
		for k, v := range binary {
			s.Data[k] = v
		}
		out, err := client.CoreV1().Secrets(namespace).Update(ctx, s, opts)
		if err != nil {
			return "", saveError(err)
		}
		return out.ResourceVersion, nil
	}
	return "", fmt.Errorf("unsupported kind %q", kind)
}

// decodeEntries validates the keys the way the API server will and splits the
// entries into text and binary values. For a ConfigMap the split is where
// they are stored (data vs binaryData); a Secret stores both in data.
func decodeEntries(kind string, entries []models.DataEntry) (map[string][]byte, map[string][]byte, error) {
	data, binary := map[string][]byte{}, map[string][]byte{}
	for _, e := range entries {
		if msgs := validation.IsConfigMapKey(e.Key); len(msgs) > 0 {
			return nil, nil, fmt.Errorf("%w: key %q: %s", ErrDataInvalid, e.Key, strings.Join(msgs, "; "))
		}
		if _, dup := data[e.Key]; dup {
			return nil, nil, fmt.Errorf("%w: key %q appears twice", ErrDataInvalid, e.Key)
		}
		if _, dup := binary[e.Key]; dup {
			return nil, nil, fmt.Errorf("%w: key %q appears twice", ErrDataInvalid, e.Key)
		}
		v, err := base64.StdEncoding.DecodeString(e.Value)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: key %q: value is not base64", ErrDataInvalid, e.Key)
		}
		// ConfigMap data must be UTF-8; a non-UTF-8 value has to go to
		// binaryData even if the editor did not mark it.
		if e.Binary || (kind == dataKindConfigMap && !utf8.Valid(v)) {
			binary[e.Key] = v
		} else {
			data[e.Key] = v
		}
	}
	return data, binary, nil
}

func checkWritable(live, loaded string, immutable *bool) error {
	if immutable != nil && *immutable {
		return ErrDataImmutable
	}
	if loaded != "" && live != loaded {
		return ErrDataConflict
	}
	return nil
}

func saveError(err error) error {
	if apierrors.IsConflict(err) {
		return fmt.Errorf("%w: %v", ErrDataConflict, err)
	}
	return err
}

// GetDataConsumers lists the workloads whose pods use the ConfigMap or Secret,
// and how. Pods are grouped by their top-level controller, so ten replicas are
// one Deployment row.
func GetDataConsumers(kind, namespace, name string, client kubernetes.Interface) ([]models.DataConsumer, error) {
	if namespace == "" || name == "" {
		return nil, errNamespaceNameRequired
	}
	ctx, cancel := context.WithTimeout(context.Background(), dataTimeout)
	defer cancel()
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	// Owners are looked up only when some pod actually uses the object; the
	// lists are best effort (RBAC may allow pods but not ReplicaSets).
	rsToDeploy, jobToCron := map[string]string{}, map[string]string{}
	ownersLoaded := false
	loadOwners := func() {
		ownersLoaded = true
		if rsl, err := client.AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{}); err == nil {
			for _, rs := range rsl.Items {
				if o := controllerRef(rs.OwnerReferences); o != nil && o.Kind == "Deployment" {
					rsToDeploy[rs.Namespace+"/"+rs.Name] = o.Name
				}
			}
		}
		if jl, err := client.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{}); err == nil {
			for _, j := range jl.Items {
				if o := controllerRef(j.OwnerReferences); o != nil && o.Kind == "CronJob" {
					jobToCron[j.Name] = o.Name
				}
			}
		}
	}

	type group struct {
		consumer models.DataConsumer
		usages   map[string]bool
	}
	groups := map[string]*group{}
	for i := range pods.Items {
		pod := &pods.Items[i]
		usages := podDataUsages(pod, kind, name)
		if len(usages) == 0 {
			continue
		}
		if !ownersLoaded {
			loadOwners()
		}
		ownerKind, ownerName := resolveOwner(pod.OwnerReferences, pod.Namespace, rsToDeploy)
		if ownerKind == "Job" {
			if cron, ok := jobToCron[ownerName]; ok {
				ownerKind, ownerName = "CronJob", cron
			}
		}
		if ownerKind == "" {
			ownerKind, ownerName = "Pod", pod.Name
		}
		key := ownerKind + "/" + ownerName
		g := groups[key]
		if g == nil {
			g = &group{consumer: models.DataConsumer{Kind: ownerKind, Name: ownerName}, usages: map[string]bool{}}
			groups[key] = g
		}
		g.consumer.Pods++
		for _, u := range usages {
			g.usages[u.label] = true
			g.consumer.NeedsRestart = g.consumer.NeedsRestart || u.restart
		}
	}

	out := make([]models.DataConsumer, 0, len(groups))
	for _, g := range groups {
		for u := range g.usages {
			g.consumer.Usages = append(g.consumer.Usages, u)
		}
		sort.Strings(g.consumer.Usages)
		out = append(out, g.consumer)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

type dataUsage struct {
	label   string
	restart bool
}

// podDataUsages reports how one pod uses the object. env and envFrom are read
// when a container starts, and so is a subPath mount (the kubelet never
// refreshes those); a plain volume mount is kept up to date by the kubelet.
func podDataUsages(pod *corev1.Pod, kind, name string) []dataUsage {
	ns := pod.Namespace
	matches := func(r models.ObjectRef) bool { return r.Kind == kind && r.Name == name }
	var out []dataUsage

	usingVolumes := map[string]bool{}
	for _, v := range pod.Spec.Volumes {
		for _, r := range podVolume(v, pod.Name, ns).Refs {
			if matches(r) {
				usingVolumes[v.Name] = true
			}
		}
	}

	containers := append(append([]corev1.Container{}, pod.Spec.InitContainers...), pod.Spec.Containers...)
	for _, c := range containers {
		for _, ef := range c.EnvFrom {
			if (kind == dataKindConfigMap && ef.ConfigMapRef != nil && ef.ConfigMapRef.Name == name) ||
				(kind == dataKindSecret && ef.SecretRef != nil && ef.SecretRef.Name == name) {
				out = append(out, dataUsage{"envFrom", true})
			}
		}
		for _, e := range c.Env {
			if v := envVar(e, ns); v.Ref != nil && matches(*v.Ref) {
				out = append(out, dataUsage{"env", true})
			}
		}
		for _, m := range c.VolumeMounts {
			if !usingVolumes[m.Name] {
				continue
			}
			if m.SubPath != "" || m.SubPathExpr != "" {
				out = append(out, dataUsage{m.MountPath + " (subPath)", true})
			} else {
				out = append(out, dataUsage{m.MountPath, false})
			}
		}
	}
	if kind == dataKindSecret {
		for _, s := range pod.Spec.ImagePullSecrets {
			if s.Name == name {
				out = append(out, dataUsage{"imagePull", false})
			}
		}
	}
	return out
}

// InspectTlsPair reads a kubernetes.io/tls certificate (the first CERTIFICATE
// block of tls.crt) and checks that the key belongs to it. Both arguments are
// base64, as the editor holds them.
func InspectTlsPair(certB64, keyB64 string) models.TlsInfo {
	info := models.TlsInfo{DNSNames: []string{}}
	certPEM, err := base64.StdEncoding.DecodeString(certB64)
	if err != nil {
		info.Error = "certificate is not base64"
		return info
	}
	var cert *x509.Certificate
	for rest := certPEM; ; {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type == "CERTIFICATE" {
			if cert, err = x509.ParseCertificate(block.Bytes); err != nil {
				info.Error = err.Error()
				return info
			}
			break
		}
	}
	if cert == nil {
		info.Error = "no PEM certificate found"
		return info
	}
	info.Subject = cert.Subject.String()
	info.Issuer = cert.Issuer.String()
	info.DNSNames = append(info.DNSNames, cert.DNSNames...)
	for _, ip := range cert.IPAddresses {
		info.DNSNames = append(info.DNSNames, ip.String())
	}
	info.NotBefore = cert.NotBefore.UTC().Format(time.RFC3339)
	info.NotAfter = cert.NotAfter.UTC().Format(time.RFC3339)

	if keyB64 == "" {
		info.KeyError = "no key"
		return info
	}
	keyPEM, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		info.KeyError = "key is not base64"
		return info
	}
	if _, err := tls.X509KeyPair(certPEM, keyPEM); err != nil {
		info.KeyError = err.Error()
		return info
	}
	info.KeyMatches = true
	return info
}

// SaveBinaryFile writes a ConfigMap or Secret value the user exported. 0600,
// because the value may well be a credential.
func SaveBinaryFile(path string, content []byte) (string, error) {
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return "", err
	}
	return path, nil
}
