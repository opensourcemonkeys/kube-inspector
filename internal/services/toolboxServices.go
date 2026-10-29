package services_k8sclient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"

	"kube-ins/internal/models"
)

// toolbox (the change recorder in toolbox/) is reached through the API
// server's service proxy with the cluster's own credentials, so no
// port-forward is needed and access is whatever the user's RBAC allows: list
// services, get the toolbox Secret, and get services/proxy.
//
// Its API token goes in X-Toolbox-Token rather than Authorization, because the
// proxy consumes Authorization for itself.
const (
	toolboxSelector    = "app.kubernetes.io/name=toolbox,app.kubernetes.io/component=collector"
	toolboxDefaultNS   = "toolbox"
	toolboxPortName    = "http"
	toolboxTokenKey    = "api-token"
	toolboxTokenHeader = "X-Toolbox-Token"
	// Discovery is three API calls; the history list polls.
	toolboxCacheTTL = time.Minute
)

// Toolbox states, as returned in models.ToolboxStatus.State.
const (
	ToolboxOK           = "ok"
	ToolboxNotInstalled = "notInstalled"
	ToolboxForbidden    = "forbidden"
	ToolboxUnreachable  = "unreachable"
)

// ToolboxError carries the state a failure maps to, so the frontend can say
// "not installed" rather than print an API error.
type ToolboxError struct {
	State string
	Err   error
	// Code is toolbox's HTTP status when it answered with one, so a caller
	// can tell "this toolbox has no such endpoint" (404) from an outage.
	Code int
}

func (e *ToolboxError) Error() string { return e.Err.Error() }
func (e *ToolboxError) Unwrap() error { return e.Err }

func toolboxErr(state string, format string, args ...any) error {
	return &ToolboxError{State: state, Err: fmt.Errorf(format, args...)}
}

// ToolboxStateOf maps any error from this file to a state.
func ToolboxStateOf(err error) string {
	var te *ToolboxError
	if errors.As(err, &te) {
		return te.State
	}
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		return ToolboxForbidden
	}
	return ToolboxUnreachable
}

type toolboxEndpoint struct {
	namespace, service, token string
	fetched                   time.Time
}

var toolboxCache = struct {
	sync.Mutex
	m map[string]toolboxEndpoint
}{m: map[string]toolboxEndpoint{}}

// Toolbox talks to one cluster's toolbox. Key names the cluster in the
// endpoint cache.
type Toolbox struct {
	Key    string
	Client kubernetes.Interface
}

func (t Toolbox) endpoint(ctx context.Context, refresh bool) (toolboxEndpoint, error) {
	toolboxCache.Lock()
	ep, ok := toolboxCache.m[t.Key]
	toolboxCache.Unlock()
	if ok && !refresh && time.Since(ep.fetched) < toolboxCacheTTL {
		return ep, nil
	}
	ep, err := discoverToolbox(ctx, t.Client)
	if err != nil {
		t.forget()
		return ep, err
	}
	toolboxCache.Lock()
	toolboxCache.m[t.Key] = ep
	toolboxCache.Unlock()
	return ep, nil
}

func (t Toolbox) forget() {
	toolboxCache.Lock()
	delete(toolboxCache.m, t.Key)
	toolboxCache.Unlock()
}

// discoverToolbox finds the toolbox Service by its chart labels and reads its
// API token from the Secret of the same name.
func discoverToolbox(ctx context.Context, client kubernetes.Interface) (toolboxEndpoint, error) {
	opts := metav1.ListOptions{LabelSelector: toolboxSelector}
	list, err := client.CoreV1().Services("").List(ctx, opts)
	if apierrors.IsForbidden(err) {
		// Many users may not list services cluster-wide; the chart's
		// documented namespace is still worth a look.
		list, err = client.CoreV1().Services(toolboxDefaultNS).List(ctx, opts)
	}
	if err != nil {
		if apierrors.IsForbidden(err) {
			return toolboxEndpoint{}, toolboxErr(ToolboxForbidden, "list services: %w", err)
		}
		return toolboxEndpoint{}, toolboxErr(ToolboxUnreachable, "list services: %w", err)
	}

	svcs := list.Items
	sort.Slice(svcs, func(i, j int) bool {
		if svcs[i].Namespace != svcs[j].Namespace {
			return svcs[i].Namespace < svcs[j].Namespace
		}
		return svcs[i].Name < svcs[j].Name
	})
	for _, svc := range svcs {
		hasPort := false
		for _, p := range svc.Spec.Ports {
			hasPort = hasPort || p.Name == toolboxPortName
		}
		if !hasPort {
			continue
		}
		secret, err := client.CoreV1().Secrets(svc.Namespace).Get(ctx, svc.Name, metav1.GetOptions{})
		switch {
		case apierrors.IsForbidden(err):
			return toolboxEndpoint{}, toolboxErr(ToolboxForbidden, "read the toolbox API token (secret %s/%s): %w", svc.Namespace, svc.Name, err)
		case apierrors.IsNotFound(err):
			return toolboxEndpoint{}, toolboxErr(ToolboxNotInstalled, "toolbox service %s/%s has no secret of the same name", svc.Namespace, svc.Name)
		case err != nil:
			return toolboxEndpoint{}, toolboxErr(ToolboxUnreachable, "read the toolbox API token: %w", err)
		}
		return toolboxEndpoint{
			namespace: svc.Namespace, service: svc.Name,
			token: string(secret.Data[toolboxTokenKey]), fetched: time.Now(),
		}, nil
	}
	return toolboxEndpoint{}, toolboxErr(ToolboxNotInstalled, "no toolbox service found")
}

// get calls a toolbox API path through the service proxy. A 401, 404 or 503
// may mean the release was reinstalled (new token, new name, new pods), so the
// endpoint is rediscovered and the call tried once more.
func (t Toolbox) get(ctx context.Context, path string, params url.Values) ([]byte, toolboxEndpoint, error) {
	var ep toolboxEndpoint
	for attempt := 0; ; attempt++ {
		var err error
		if ep, err = t.endpoint(ctx, attempt > 0); err != nil {
			return nil, ep, err
		}
		req := t.Client.CoreV1().RESTClient().Get().
			Namespace(ep.namespace).Resource("services").Name(ep.service+":"+toolboxPortName).
			SubResource("proxy").Suffix(path).
			SetHeader(toolboxTokenHeader, ep.token)
		for k, vs := range params {
			for _, v := range vs {
				req = req.Param(k, v)
			}
		}
		body, err := req.DoRaw(ctx)
		if err == nil {
			return body, ep, nil
		}
		code := statusCode(err)
		if attempt == 0 && (code == http.StatusUnauthorized || code == http.StatusNotFound || code == http.StatusServiceUnavailable) {
			t.forget()
			continue
		}
		if code == http.StatusForbidden {
			t.forget()
			return nil, ep, toolboxErr(ToolboxForbidden, "toolbox %s: %w", path, err)
		}
		if code == http.StatusBadRequest {
			// toolbox's own validation message ({"error": "..."}).
			return nil, ep, fmt.Errorf("toolbox: %s", toolboxMessage(body, err))
		}
		return nil, ep, &ToolboxError{State: ToolboxUnreachable, Code: code,
			Err: fmt.Errorf("toolbox %s: %s", path, toolboxMessage(body, err))}
	}
}

func statusCode(err error) int {
	var s apierrors.APIStatus
	if errors.As(err, &s) {
		return int(s.Status().Code)
	}
	return 0
}

func toolboxMessage(body []byte, err error) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error != "" {
		return e.Error
	}
	return err.Error()
}

// isToolboxNotFound reports whether toolbox itself answered 404, i.e. this
// release does not have the endpoint.
func isToolboxNotFound(err error) bool {
	var te *ToolboxError
	return errors.As(err, &te) && te.Code == http.StatusNotFound
}

// GetToolboxStatus says whether toolbox can be used, never failing: the
// failure is the answer.
func GetToolboxStatus(ctx context.Context, t Toolbox) models.ToolboxStatus {
	body, ep, err := t.get(ctx, "api/v1/info", nil)
	st := models.ToolboxStatus{Namespace: ep.namespace, Service: ep.service}
	if err != nil {
		st.State, st.Detail = ToolboxStateOf(err), err.Error()
		return st
	}
	var info struct{ Cluster, Version string }
	if err := json.Unmarshal(body, &info); err != nil {
		st.State, st.Detail = ToolboxUnreachable, "unexpected answer from toolbox: "+err.Error()
		return st
	}
	st.State, st.Cluster, st.Version = ToolboxOK, info.Cluster, info.Version
	return st
}

func changeParams(f models.ToolboxChangeFilter) url.Values {
	p := url.Values{}
	set := func(k, v string) {
		if v != "" {
			p.Set(k, v)
		}
	}
	set("q", f.Q)
	set("group", f.Group)
	set("namespace", f.Namespace)
	set("resource", f.Resource)
	set("kind", f.Kind)
	set("name", f.Name)
	set("user", f.User)
	set("verb", f.Verb)
	set("attribution", f.Attribution)
	set("path", f.Path)
	set("since", f.Since)
	set("until", f.Until)
	set("cursor", f.Cursor)
	if f.Limit > 0 {
		p.Set("limit", strconv.Itoa(f.Limit))
	}
	return p
}

func ListToolboxChanges(ctx context.Context, t Toolbox, f models.ToolboxChangeFilter) (models.ToolboxChangePage, error) {
	var page models.ToolboxChangePage
	body, _, err := t.get(ctx, "api/v1/changes", changeParams(f))
	if err != nil {
		return page, err
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return page, fmt.Errorf("decode toolbox changes: %w", err)
	}
	if page.Items == nil {
		page.Items = []models.ToolboxChange{}
	}
	return page, nil
}

func attemptParams(f models.ToolboxChangeFilter) url.Values {
	// Audited requests are not changes: they have no kind, attribution or
	// changed paths.
	f.Q, f.Verb, f.Kind, f.Attribution, f.Path, f.Group = "", "", "", "", "", ""
	return changeParams(f)
}

func ListToolboxAttempts(ctx context.Context, t Toolbox, f models.ToolboxChangeFilter) (models.ToolboxAttemptPage, error) {
	var page models.ToolboxAttemptPage
	body, _, err := t.get(ctx, "api/v1/attempts", attemptParams(f))
	if err != nil {
		return page, err
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return page, fmt.Errorf("decode toolbox attempts: %w", err)
	}
	if page.Items == nil {
		page.Items = []models.ToolboxAttempt{}
	}
	return page, nil
}

func ListToolboxUsers(ctx context.Context, t Toolbox, since string) ([]models.ToolboxUser, error) {
	p := url.Values{}
	if since != "" {
		p.Set("since", since)
	}
	body, _, err := t.get(ctx, "api/v1/users", p)
	if err != nil {
		return nil, err
	}
	var res struct{ Items []models.ToolboxUser }
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, fmt.Errorf("decode toolbox users: %w", err)
	}
	if res.Items == nil {
		res.Items = []models.ToolboxUser{}
	}
	return res.Items, nil
}

// GetToolboxHealth reads toolbox's recording health. A toolbox from before
// /api/v1/health answers 404 through the proxy (after the one rediscovery a
// 404 triggers); that is reported as Supported=false, not as an error.
func GetToolboxHealth(ctx context.Context, t Toolbox) (models.ToolboxHealth, error) {
	var h models.ToolboxHealth
	body, _, err := t.get(ctx, "api/v1/health", nil)
	if err != nil {
		if isToolboxNotFound(err) {
			return h, nil
		}
		return h, err
	}
	if err := json.Unmarshal(body, &h); err != nil {
		return h, fmt.Errorf("decode toolbox health: %w", err)
	}
	h.Supported = true
	if h.Coverage.Gaps == nil {
		h.Coverage.Gaps = []models.ToolboxGap{}
	}
	return h, nil
}

// ListToolboxGaps returns the recording gaps in [since, until] (a duration
// like "168h" or RFC 3339; empty until is now). An old toolbox has none to
// report.
func ListToolboxGaps(ctx context.Context, t Toolbox, since, until string) (models.ToolboxCoverage, error) {
	var cov models.ToolboxCoverage
	p := url.Values{}
	if since != "" {
		p.Set("since", since)
	}
	if until != "" {
		p.Set("until", until)
	}
	body, _, err := t.get(ctx, "api/v1/gaps", p)
	if err != nil {
		if isToolboxNotFound(err) {
			return models.ToolboxCoverage{Gaps: []models.ToolboxGap{}}, nil
		}
		return cov, err
	}
	if err := json.Unmarshal(body, &cov); err != nil {
		return cov, fmt.Errorf("decode toolbox gaps: %w", err)
	}
	if cov.Gaps == nil {
		cov.Gaps = []models.ToolboxGap{}
	}
	return cov, nil
}

// GetToolboxStats reads toolbox's summary of a period.
func GetToolboxStats(ctx context.Context, t Toolbox, f models.ToolboxStatsFilter) (models.ToolboxStats, error) {
	var st models.ToolboxStats
	p := url.Values{}
	for k, v := range map[string]string{"since": f.Since, "until": f.Until, "namespace": f.Namespace, "bucket": f.Bucket} {
		if v != "" {
			p.Set(k, v)
		}
	}
	body, _, err := t.get(ctx, "api/v1/stats", p)
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(body, &st); err != nil {
		return st, fmt.Errorf("decode toolbox stats: %w", err)
	}
	for _, l := range []*[]models.ToolboxCount{&st.ByResource, &st.ByUser, &st.ByNamespace} {
		if *l == nil {
			*l = []models.ToolboxCount{}
		}
	}
	if st.Buckets == nil {
		st.Buckets = []models.ToolboxBucket{}
	}
	return st, nil
}

// toolboxChange is a change with the stored objects, which toolbox sends as
// JSON strings.
type toolboxChange struct {
	models.ToolboxChange
	Before string `json:"before"`
	After  string `json:"after"`
}

func getToolboxChange(ctx context.Context, t Toolbox, eventID string) (toolboxChange, error) {
	var ch toolboxChange
	// The ID goes into the proxied path.
	if _, err := uuid.Parse(eventID); err != nil {
		return ch, fmt.Errorf("invalid change id %q", eventID)
	}
	body, _, err := t.get(ctx, "api/v1/changes/"+eventID, nil)
	if err != nil {
		return ch, err
	}
	if err := json.Unmarshal(body, &ch); err != nil {
		return ch, fmt.Errorf("decode toolbox change: %w", err)
	}
	return ch, nil
}

func isCoreSecret(group, resource string) bool { return group == "" && resource == "secrets" }

func GetToolboxChangeDetail(ctx context.Context, t Toolbox, eventID string) (models.ToolboxChangeDetail, error) {
	ch, err := getToolboxChange(ctx, t, eventID)
	if err != nil {
		return models.ToolboxChangeDetail{}, err
	}
	d := models.ToolboxChangeDetail{Change: ch.ToolboxChange}
	if isCoreSecret(ch.Group, ch.Resource) {
		d.RollbackBlocked = "secretRedacted"
	}
	for _, side := range []struct {
		raw            string
		full, restored *string
	}{{ch.Before, &d.BeforeYaml, &d.BeforeRestorable}, {ch.After, &d.AfterYaml, &d.AfterRestorable}} {
		obj, err := decodeObject(side.raw)
		if err != nil {
			return d, err
		}
		if obj == nil {
			continue
		}
		if *side.full, err = toYaml(obj); err != nil {
			return d, err
		}
		if *side.restored, err = toYaml(restorable(obj)); err != nil {
			return d, err
		}
	}
	return d, nil
}

func decodeObject(raw string) (map[string]any, error) {
	if raw == "" {
		return nil, nil
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return nil, fmt.Errorf("decode stored object: %w", err)
	}
	return obj, nil
}

func toYaml(obj map[string]any) (string, error) {
	if obj == nil {
		return "", nil
	}
	b, err := yaml.Marshal(obj)
	return string(b), err
}

// restorable is what a rollback writes and what is compared with the live
// object: the stored object minus what the API server owns. It strips the same
// fields as cleanUnstructured, plus the deletion markers a version recorded
// mid-deletion carries. Modifies obj in place.
func restorable(obj map[string]any) map[string]any {
	if obj == nil {
		return nil
	}
	cleanUnstructured(&unstructured.Unstructured{Object: obj})
	unstructured.RemoveNestedField(obj, "metadata", "deletionTimestamp")
	unstructured.RemoveNestedField(obj, "metadata", "deletionGracePeriodSeconds")
	return obj
}

// redactSecret hides a live Secret's values the way toolbox stores them, so a
// comparison with a recorded version still shows which keys changed. It must
// match redact in toolbox/internal/diff/diff.go.
func redactSecret(obj map[string]any) {
	redact := func(v any) string {
		b, _ := json.Marshal(v)
		sum := sha256.Sum256(b)
		return "sha256:" + hex.EncodeToString(sum[:6])
	}
	for _, field := range []string{"data", "stringData"} {
		if m, ok := obj[field].(map[string]any); ok {
			for k, v := range m {
				m[k] = redact(v)
			}
		}
	}
	if ann, ok, _ := unstructured.NestedMap(obj, "metadata", "annotations"); ok {
		const lastApplied = "kubectl.kubernetes.io/last-applied-configuration"
		if v, ok := ann[lastApplied]; ok {
			_ = unstructured.SetNestedField(obj, redact(v), "metadata", "annotations", lastApplied)
		}
	}
}

func toolboxResource(dyn dynamic.Interface, group, version, resource, namespace string) dynamic.ResourceInterface {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: resource}
	if namespace != "" {
		return dyn.Resource(gvr).Namespace(namespace)
	}
	return dyn.Resource(gvr)
}

// GetToolboxLiveObject returns the object as it is now, cleaned like a
// restorable version. It is addressed by the version toolbox recorded, so the
// two sides of a comparison are in the same API version.
func GetToolboxLiveObject(ctx context.Context, dyn dynamic.Interface, group, version, resource, namespace, name string) (models.ToolboxLiveObject, error) {
	u, err := toolboxResource(dyn, group, version, resource, namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return models.ToolboxLiveObject{}, nil
	}
	if err != nil {
		return models.ToolboxLiveObject{}, err
	}
	obj := restorable(u.Object)
	if isCoreSecret(group, resource) {
		redactSecret(obj)
	}
	y, err := toYaml(obj)
	return models.ToolboxLiveObject{Exists: true, Yaml: y}, err
}

// RollbackToolboxChange writes one side ("before" or "after") of a recorded
// change back to the cluster. The object is replaced, not merged: fields added
// since that version are removed, which server-side apply would leave alone.
// The live resourceVersion is sent, so a write that lands in between makes
// this fail instead of being overwritten unseen. A deleted object is created
// again. The version is read from toolbox here, never from the caller.
func RollbackToolboxChange(ctx context.Context, t Toolbox, dyn dynamic.Interface, eventID, side string) (string, error) {
	return rollbackToolboxChange(ctx, t, dyn, eventID, side, false)
}

// DryRunToolboxRollback runs the same write as RollbackToolboxChange with
// dryRun=All, so validation and admission (webhooks, quotas, a namespace that
// is gone) answer before anything is written.
func DryRunToolboxRollback(ctx context.Context, t Toolbox, dyn dynamic.Interface, eventID, side string) (string, error) {
	return rollbackToolboxChange(ctx, t, dyn, eventID, side, true)
}

func rollbackToolboxChange(ctx context.Context, t Toolbox, dyn dynamic.Interface, eventID, side string, dryRun bool) (string, error) {
	ch, err := getToolboxChange(ctx, t, eventID)
	if err != nil {
		return "", err
	}
	if isCoreSecret(ch.Group, ch.Resource) {
		return "", errors.New("secrets cannot be rolled back: toolbox does not store their values")
	}
	raw := ch.After
	if side == "before" {
		raw = ch.Before
	} else if side != "after" {
		return "", fmt.Errorf("unknown side %q", side)
	}
	obj, err := decodeObject(raw)
	if err != nil {
		return "", err
	}
	if obj == nil {
		return "", fmt.Errorf("there is no %s version of this change to restore", side)
	}
	u := &unstructured.Unstructured{Object: restorable(obj)}
	ri := toolboxResource(dyn, ch.Group, ch.APIVersion, ch.Resource, ch.Namespace)
	target := ch.Kind + "/" + ch.Name
	var dry []string
	verbs := [2]string{"re-created", "rolled back"}
	if dryRun {
		dry = []string{metav1.DryRunAll}
		verbs = [2]string{"can be re-created", "can be rolled back"}
	}

	live, err := ri.Get(ctx, ch.Name, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		// The API server's answer for a missing namespace is a bare
		// NotFound that reads like the object itself is missing.
		if ch.Namespace != "" {
			if _, err := t.Client.CoreV1().Namespaces().Get(ctx, ch.Namespace, metav1.GetOptions{}); apierrors.IsNotFound(err) {
				return "", fmt.Errorf("namespace %s no longer exists; create it first, then re-create %s", ch.Namespace, target)
			}
		}
		if _, err := ri.Create(ctx, u, metav1.CreateOptions{FieldManager: fieldManager, DryRun: dry}); err != nil {
			return "", fmt.Errorf("re-create %s: %w", target, err)
		}
		return target + " " + verbs[0], nil
	case err != nil:
		return "", fmt.Errorf("read live %s: %w", target, err)
	}
	u.SetResourceVersion(live.GetResourceVersion())
	if _, err := ri.Update(ctx, u, metav1.UpdateOptions{FieldManager: fieldManager, DryRun: dry}); err != nil {
		if apierrors.IsConflict(err) {
			return "", fmt.Errorf("%s changed while rolling back; compare again and retry", target)
		}
		return "", fmt.Errorf("roll back %s: %w", target, err)
	}
	return target + " " + verbs[1], nil
}
