package models

// DataEntry is one key of a ConfigMap or Secret. Value is always base64, in
// both directions, so a binary value survives the trip through JSON byte for
// byte. Binary marks a ConfigMap binaryData key, or a Secret value that is not
// valid UTF-8 — the editor offers those as files rather than text.
type DataEntry struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Binary bool   `json:"binary"`
}

// DataObject is a ConfigMap or Secret as the key/value editor sees it.
// ResourceVersion is sent back on save, so a change made by someone else in
// the meantime fails instead of being overwritten.
type DataObject struct {
	Kind            string      `json:"kind"`
	Name            string      `json:"name"`
	Namespace       string      `json:"namespace"`
	ResourceVersion string      `json:"resourceVersion"`
	Type            string      `json:"type"`
	Immutable       bool        `json:"immutable"`
	Entries         []DataEntry `json:"entries"`
}

// DataConsumer is a workload whose pods use a ConfigMap or Secret. Usages say
// how ("env", "envFrom", "/etc/app", "/etc/app/x (subPath)", "imagePull").
// NeedsRestart is set when a usage only reads the object when a container
// starts: env, envFrom and subPath mounts. Plain volume mounts are refreshed
// by the kubelet on their own.
type DataConsumer struct {
	Kind         string   `json:"kind"`
	Name         string   `json:"name"`
	Usages       []string `json:"usages"`
	NeedsRestart bool     `json:"needsRestart"`
	Pods         int      `json:"pods"`
}

// DataSaveResult is the outcome of saving (or dry-running) a DataObject. Code
// is "" on success, otherwise one the editor words itself: "conflict" (changed
// since it was loaded), "immutable", "invalid" (a key the API would refuse) or
// "rejected" (the API server's own refusal, in Message).
type DataSaveResult struct {
	Code            string `json:"code"`
	Message         string `json:"message"`
	ResourceVersion string `json:"resourceVersion"`
}

// TlsInfo describes a kubernetes.io/tls certificate and whether its key
// belongs to it. Error is set when the certificate cannot be read, KeyError
// when the key cannot be read or does not belong to the certificate.
type TlsInfo struct {
	Subject    string   `json:"subject"`
	Issuer     string   `json:"issuer"`
	DNSNames   []string `json:"dnsNames"`
	NotBefore  string   `json:"notBefore"`
	NotAfter   string   `json:"notAfter"`
	KeyMatches bool     `json:"keyMatches"`
	Error      string   `json:"error"`
	KeyError   string   `json:"keyError"`
}
