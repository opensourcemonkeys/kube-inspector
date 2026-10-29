// Package watcher runs one dynamic informer per discovered resource and
// reports every persisted change to a handler. It is the source of truth for
// *what* changed; who changed it is filled in later by the correlator.
package watcher

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	discoveryclient "k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"

	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/discovery"
	"github.com/kubeinspector/toolbox/internal/metrics"
	"github.com/kubeinspector/toolbox/internal/safego"
)

type EventType int

const (
	Added EventType = iota
	Updated
	Deleted
)

// Event is one persisted change. Old is nil for Added, New is nil for Deleted.
type Event struct {
	Type     EventType
	Resource discovery.Resource
	Old, New *unstructured.Unstructured
	Observed time.Time
}

type Watcher struct {
	dyn      dynamic.Interface
	disc     discoveryclient.DiscoveryInterface
	filter   *config.ResourceFilter
	interval time.Duration
	handle   func(Event)

	running map[schema.GroupVersionResource]chan struct{}
	watched atomic.Int32 // len(running), readable from other goroutines
}

// Watched is how many resources are being watched right now.
func (w *Watcher) Watched() int { return int(w.watched.Load()) }

func New(dyn dynamic.Interface, disc discoveryclient.DiscoveryInterface, w config.Watch, handle func(Event)) *Watcher {
	return &Watcher{
		dyn: dyn, disc: disc, filter: w.Filter(), interval: w.DiscoveryInterval.Duration, handle: handle,
		running: map[schema.GroupVersionResource]chan struct{}{},
	}
}

// Run re-discovers resources every interval, starting informers for new ones
// (a CRD just installed) and stopping those that went away, until ctx ends.
func (w *Watcher) Run(ctx context.Context) {
	t := time.NewTicker(w.interval)
	defer t.Stop()
	for {
		w.sync()
		select {
		case <-ctx.Done():
			for gvr, stop := range w.running {
				close(stop)
				delete(w.running, gvr)
			}
			return
		case <-t.C:
		}
	}
}

func (w *Watcher) sync() {
	resources, err := discovery.Discover(w.disc, w.filter)
	if err != nil {
		slog.Error("discovery failed", "err", err)
		return
	}
	seen := map[schema.GroupVersionResource]bool{}
	for _, r := range resources {
		seen[r.GVR] = true
		if _, ok := w.running[r.GVR]; !ok {
			w.running[r.GVR] = w.start(r)
			slog.Info("watching", "resource", r.GVR.String())
		}
	}
	for gvr, stop := range w.running {
		if !seen[gvr] {
			close(stop)
			delete(w.running, gvr)
			slog.Info("stopped watching", "resource", gvr.String())
		}
	}
	w.watched.Store(int32(len(w.running)))
	metrics.WatchedResources.Set(float64(len(w.running)))
}

func (w *Watcher) start(r discovery.Resource) chan struct{} {
	stop := make(chan struct{})
	inf := dynamicinformer.NewFilteredDynamicInformer(w.dyn, r.GVR, "", 0, cache.Indexers{}, nil).Informer()
	_ = inf.SetTransform(trimManagedFields)
	_ = inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
		slog.Warn("watch error", "resource", r.GVR.String(), "err", err)
	})
	_, _ = inf.AddEventHandler(cache.ResourceEventHandlerDetailedFuncs{
		AddFunc: func(obj any, isInInitialList bool) {
			// The initial list is the state we start from, not a change.
			if isInInitialList {
				return
			}
			if u, ok := obj.(*unstructured.Unstructured); ok && w.filter.AllowsNamespace(u.GetNamespace()) {
				w.emit(Event{Type: Added, Resource: r, New: u, Observed: time.Now()})
			}
		},
		UpdateFunc: func(oldObj, newObj any) {
			o, ok1 := oldObj.(*unstructured.Unstructured)
			n, ok2 := newObj.(*unstructured.Unstructured)
			if !ok1 || !ok2 || o.GetResourceVersion() == n.GetResourceVersion() || !w.filter.AllowsNamespace(n.GetNamespace()) {
				return
			}
			w.emit(Event{Type: Updated, Resource: r, Old: o, New: n, Observed: time.Now()})
		},
		DeleteFunc: func(obj any) {
			if d, ok := obj.(cache.DeletedFinalStateUnknown); ok {
				obj = d.Obj
			}
			if u, ok := obj.(*unstructured.Unstructured); ok && w.filter.AllowsNamespace(u.GetNamespace()) {
				w.emit(Event{Type: Deleted, Resource: r, Old: u, Observed: time.Now()})
			}
		},
	})
	safego.Go("watcher.informer."+r.GVR.Resource, func() { inf.Run(stop) })
	return stop
}

func (w *Watcher) emit(e Event) {
	defer safego.Recover("watcher.handle")
	w.handle(e)
}

// trimManagedFields drops the field sets from managedFields entries. The
// informer cache holds every watched object, and fieldsV1 is often the largest
// part of one; the correlator reads only who wrote when (diff.Writer), and it
// needs every entry for that, status ones included.
func trimManagedFields(obj any) (any, error) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return obj, nil
	}
	entries := u.GetManagedFields()
	if len(entries) == 0 {
		return u, nil
	}
	for i := range entries {
		entries[i].FieldsV1 = nil
		entries[i].FieldsType = ""
	}
	u.SetManagedFields(entries)
	return u, nil
}
