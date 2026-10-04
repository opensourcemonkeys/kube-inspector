package models

type ResourceQuotaEntry struct {
	Resource string `json:"resource"`
	Hard     string `json:"hard"`
	Used     string `json:"used"`
	// Remaining is Hard − Used in Kubernetes quantity notation ("2500m",
	// "5Gi"). It goes negative when a quota was lowered below current usage.
	Remaining string `json:"remaining"`
	HardNum   int64  `json:"hard_num"`
	UsedNum   int64  `json:"used_num"`
}

type ResourceQuotaInfo struct {
	Name    string               `json:"name"`
	Entries []ResourceQuotaEntry `json:"entries"`
}

// NamespacedResourceQuota is a flat quota row for cross-namespace listings
// (used by the TUI); NamespaceInfo above keeps quotas nested per namespace for
// the desktop's namespace view.
type NamespacedResourceQuota struct {
	Namespace string               `json:"namespace"`
	Name      string               `json:"name"`
	Entries   []ResourceQuotaEntry `json:"entries"`
}

type NamespaceInfo struct {
	Name           string              `json:"name"`
	Status         string              `json:"status"`
	ResourceQuotas []ResourceQuotaInfo `json:"resource_quotas"`
}
