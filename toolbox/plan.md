# Toolbox (operatör + desktop Cluster Toolbox) iyileştirme planı

> Çalışma şekli: her aşamada kararı kullanıcı verir. Bu dosyada **[ÖNERİ]** = henüz onaylanmadı,
> **[ONAY]** = kullanıcı onayladı, **[RET]** = elendi. Onaylanmadan hiçbir madde koda dönüşmez.

## Durum

| Faz | Durum | Not |
|---|---|---|
| 1 — Desktop hızlı kazanımlar | bitti, onaylandı (2026-10-29) | aşağıda "Faz 1 sonucu" |
| 2 — Obje geçmişi + rollback | bitti, onaylandı (2026-10-29) | aşağıda "Faz 2 sonucu" |
| 3 — Kayıt sağlığı + CI | bitti, onaylandı (2026-10-29) | aşağıda "Faz 3 sonucu" |
| 4 — Genel bakış | bitti, onaylandı (2026-10-29) | aşağıda "Faz 4 sonucu" |
| 5 — Attempts/Users/Export | bitti, onaylandı (2026-10-29) | aşağıda "Faz 5 sonucu" |
| 6 — Performans | bitti, onaylandı (2026-10-29) | aşağıda "Faz 6 sonucu" |
| 7 — Web UI, TUI, canlı akış | bitti, onaylandı (2026-10-30) | aşağıda "Faz 7 sonucu" |
| 8 — Dokümantasyon | bitti — kullanıcı onayı bekleniyor | aşağıda "Faz 8 sonucu" |

## Context

`toolbox/` bir Kubernetes controller'ı: informer + admission webhook + audit webhook ile her
create/update/delete'i "kim, ne zaman, nereden, ne değişti" olarak ClickHouse'a yazıyor; REST API +
gömülü küçük bir web UI sunuyor. Desktop app bunu `ToolboxPanel` (araç listesi + durum) ve
`ClusterHistoryPanel` + `ChangeDiff` (değişiklik listesi, Monaco diff, rollback) ile okuyor
(API server service proxy üzerinden). Amaç: iki taraftaki eksik/zayıf noktaları bulup aşama aşama
iyileştirmek.

İncelenen dosyalar:
- Operatör: `toolbox/internal/{api,store,web/static,watcher,correlate,config,metrics}`, `cmd/toolbox/main.go`, `deploy/helm/toolbox/values.yaml`, `README.md`
- Desktop: `frontend/src/components/toolbox/ToolboxPanel.tsx`, `history/ClusterHistoryPanel.tsx`, `history/ChangeDiff.tsx`, `internal/services/toolboxServices.go`, `internal/business/toolbox.go`, `internal/models/toolboxInfo.go`

---

## Aşama 0 — Bulgular (inceleme sonucu)

### A. API'de olup hiçbir ekranın kullanmadığı yetenekler
- **A1** `GET /api/v1/stats` (zaman kovası × verb, top resource/user/namespace) — ne desktop ne web UI kullanıyor. Bir "genel bakış" ekranı yok.
- **A2** `GET /api/v1/objects/.../history` (tek objenin zaman çizelgesi) — desktop'ta kullanılmıyor. Bir pod/deployment'ın YAML/detay panelinden "bu objenin geçmişi" diye girilecek yer yok; kullanıcı history'yi elle filtrelemek zorunda.
- **A3** Filtreler: API `kind`, `group`, `name`, `uid`, `attribution`, `path` (JSON pointer, ör. `/spec/replicas`), `until` destekliyor; desktop yalnızca q/namespace/resource/user/verb/since gönderiyor (`name` modelde var ama UI'da input yok). "spec.replicas'ı kim değiştirdi?" ve "dün 14:00–15:00 arası" soruları cevaplanamıyor.

### B. Desktop Cluster History ekranı
- **B1** Hücreden pivot yok: namespace / user / object / IP hücresine tıklayıp filtreye ekleme yok (sadece Users görünümünde satır → user filtresi var).
- **B2** Filtreler ve görünüm tab kapanınca kayboluyor (projede kalıcı per-tab state için zustand + `persist` deseni var, `eventsStore.ts`).
- **B3** Rejected (attempts) görünümünde sayfalama yok (tek seferde limit 100), satır detayı yok (requestUri, user agent, groups gösterilmiyor).
- **B4** Users görünümünde gruplar yok; zaman aralığı "all" için `87600h` hack'i var.
- **B5** Zaman yalnızca mutlak; göreli ("5 dk önce") veya tooltip yok. Attribution (`audit/admission/managedFields/none`) ham string, güven seviyesi görsel olarak anlatılmıyor.
- **B6** Dışa aktarma yok (CSV/JSON) — denetim/compliance için tipik ihtiyaç.

### C. Rollback / ChangeDiff
- **C1** Rollback öncesi **server-side dry-run** yok: admission/validation hatası ancak gerçek yazımda çıkıyor. Onay dialogunda dry-run sonucunu göstermek güvenliği artırır.
- **C2** Yalnızca "tek değişikliği geri al" var; obje zaman çizelgesinden "bu noktaya dön" akışı yok (A2 ile birlikte).
- **C3** Namespace silinmişse re-create hata verir; mesaj anlaşılır değil.
- **C4** Rollback sonrası liste 20 sn sonra yenileniyor (sabit `setTimeout`), rollback'in kendisi olarak kaydedilen değişikliği vurgulamıyor.

### D. ToolboxPanel (durum / kurulum)
- **D1** Durum sadece "ok / notInstalled / forbidden / unreachable". Toolbox'ın **ne kadar iyi kaydettiği** görünmüyor: audit webhook bağlı mı (kaynak IP var mı), son admission/audit hint ne zaman geldi, leader var mı, izlenen resource sayısı, pending/dropped satır, retention gün sayısı. Bunun için operatörde `info` zenginleştirilmeli (veya yeni `/api/v1/health`).
- **D2** "notInstalled" durumunda kurulum rehberi yok (helm komutu kopyalama, gerekli değerler).
- **D3** Operatörün kendi web UI'ını açma kısayolu yok (proxy URL veya port-forward ile).
- **D4** Cluster migration satırı placeholder (kapsam dışı mı, ayrı mı ele alınacak?).

### E. Operatör (toolbox/) tarafı
- **E1** Kayıt boşlukları görünmez: leader yokken (restart, failover) olan değişiklikler kaybolur ve UI bunu bilmez. Leader start/stop'u bir `recorder_sessions` tablosuna yazıp API'den "kayıt boşlukları" vermek, UI'da listede "bu aralıkta kayıt yok" şeridi göstermek mümkün.
- **E2** Performans: her sorgu `FINAL` ile ve `ORDER BY (cluster, resource, namespace, name, event_time…)` anahtarıyla; "en yeni önce, tüm cluster" listesi ve `q` (positionCaseInsensitive) büyük tabloda tam tarama yapar. `event_time` sıralı bir projection / skip index değerlendirilebilir.
- **E3** Attempts endpoint'inde cursor yok (B3'ün backend'i).
- **E4** Gömülü web UI: diff yok (ham before/after JSON), stats yok, URL'de state yok (link paylaşılamıyor), zaman aralığı/until yok. Desktop'la arayı kapatmak mı, minimal tutmak mı — karar gerekli.
- **E5** Canlı akış yok (15 sn polling). SSE `/api/v1/changes/stream` mümkün ama proxy üzerinden maliyet/karmaşıklık var — muhtemelen düşük öncelik.

### F. Diğer
- **F1** TUI'da toolbox/history görünümü yok.

---

## Aşama 1 — Kapsam ve önceliklendirme

- **[ONAY]** Kapsam: A, B, C, D, E (E1–E4), F gruplarının hepsi.
- **[ONAY]** Çalışma dosyası: `toolbox/plan.md` (plan modundan çıkınca bu içerik oraya taşınır ve orada ilerler).
- **[ONAY]** D4 (migration) kapsam dışı — ayrı proje. E5 (SSE canlı akış) kapsamda, en sonda.
- **[ONAY]** Sıra:
  1. Desktop hızlı kazanımlar (operatör değişikliği yok): A3 filtreler, B1 pivot, B2 kalıcı filtre, B5 zaman/attribution gösterimi
  2. Obje geçmişi + güvenli rollback: A2, C2, C1 dry-run, C3, C4
  3. Kayıt sağlığı: E1 kayıt boşlukları + D1 zengin health (operatör) → ToolboxPanel'de gösterim, D2 kurulum rehberi + toolbox CI (D3 elendi)
  4. Genel bakış ekranı: A1 stats
  5. Attempts/Users/Export: E3 cursor → B3, B4, B6
  6. Performans: E2
  7. Web UI + TUI + canlı akış: E4, F1, E5

---

## Faz 1 — Desktop hızlı kazanımlar (A3, B1, B2, B5)

**Kararlar:**
- **[ONAY] 1-a** Tüm filtreler satır içinde, sığmayınca alt satıra sarar (`.history-filters` flex-wrap).
- **[ONAY] 1-b** Hazır aralıklar + "Özel aralık" seçeneği → PrimeReact `Calendar` (range, saatli). Uygulamadaki ilk Calendar: stil `theme-monolith.css`'e global `.p-calendar` / `.p-datepicker` override olarak eklenir; açılış animasyonu mevcut "Opening and closing" bloğuna bağlanır.
- **[ONAY] 1-c** Pivot: hücre hover'ında (ve klavye odağında) beliren küçük `RowAction` filtre ikonu; tıklama satırın detay açmasını tetiklemez (`stopPropagation`).
- **[ONAY] 1-d** Kalıcılık yalnız oturum boyunca: `persist`'siz zustand store (`metricsStore.ts` deseni), anahtar `history:${clusterName}`.
- **[ONAY] 1-e** IP pivotu yok; **Source IP sütunu changes, attempts ve users tablolarından kaldırılır**. IP yalnız `ChangeDiff` detay panelindeki facts listesinde kalır. Operatöre dokunulmaz. Pivot ikonları: namespace, user, obje (name + resource).
- **[ONAY] 1-f** Zaman: göreli ("5m", `lib/time.ts` kubectl tarzı) görünür, tooltip'te mutlak `formatTime`. Changes, attempts ve users (last seen) tablolarında aynı. Detay panelinde mutlak kalır.
- **[ONAY] 1-g** Via: 3 kademeli şekil işareti (●●● audit, ●●○ admission, ●○○ managedFields, ○○○ none) + okunur etiket + kaynağın ne verdiğini anlatan tooltip. Renk yok; işaret `aria-hidden`, anlamı etiket taşır. Yeni küçük bileşen `history/Attribution.tsx`, detaydaki "Attributed via" satırında da kullanılır.

Operatör değişikliği yok: API bu filtreleri zaten destekliyor.

**Backend (desktop Go):**
- `internal/models/toolboxInfo.go::ToolboxChangeFilter` → `Kind`, `Path`, `Attribution`, `Until` alanları eklenir.
- `internal/services/toolboxServices.go::changeParams` → bu alanlar query'ye geçer; `ListToolboxAttempts` attempts'in desteklemediği alanları (q/verb/cursor gibi) zaten sıfırlıyor, yenileri de oraya eklenir (`path`, `attribution`, `kind`).
- `toolboxServices_test.go` → changeParams için tablo testi.
- `wails generate module` ile binding yenilenir.

**Frontend:**
- A3: `ClusterHistoryPanel.tsx` `Filters` tipine `name`, `kind`, `path`, `attribution`, `until` eklenir (1-a, 1-b). Attempts görünümünde yalnız attempts'in desteklediği alanlar görünür.
- B1: pivot ikonları namespace, user, obje (name + resource) hücrelerinde (1-c).
- B2: yeni `stores/historyStore.ts` (persist'siz, 1-d): filtreler + seçili görünüm.
- B5: `lib/time.ts` göreli zaman (1-f) + yeni `history/Attribution.tsx` (1-g).
- Source IP sütunları kaldırılır (1-e).
- i18n: yeni metinler 6 dilde (`frontend/src/locales/{en,tr,de,ja,ru,zh}/panels.json`).
- `theme-monolith.css`: Calendar/datepicker override'ları, pivot ikonunun hover/focus görünürlüğü, attribution işareti.

**Doğrulama:** `go test ./internal/services -run Toolbox`, `npm run build`, kind + toolbox'a karşı `make dev` ile: path filtresi `/spec/replicas` → yalnız scale değişiklikleri; pivot tıklaması filtreye ekliyor; tab kapat/aç → filtreler duruyor.

### Faz 1 sonucu (2026-10-29)

**Yapılanlar:**
- Desktop Go: `ToolboxChangeFilter` + `changeParams`'a `kind`, `attribution`, `path`, `until`; attempts bunları göndermez. Testler: `TestChangeParams`, `TestAttemptsDropChangeOnlyFilters`.
- Frontend: `stores/historyStore.ts` (oturum boyu, persist yok) + testi; `history/Attribution.tsx`; `format.tsx::AgeCell`; `ClusterHistoryPanel.tsx` yeni filtreler, özel aralık (Calendar), pivot ikonları, Source IP sütunları kaldırıldı; `ChangeDiff` "Attributed via" satırı `Attribution` ile.
- `theme-monolith.css`: Calendar/datepicker override'ları, pivot ve attribution stilleri. i18n 6 dil.
- `scripts/ui/capture.py` + `contrast_scan.py`: `toolbox`, `cluster-history`, `history-range` senaryoları.
- `CLAUDE.md` toolbox bölümüne "List filters" maddesi.

**Doğrulama:**
- `go test ./internal/services/ ./internal/business/` geçti; `tsc`, `eslint` temiz; `vitest` 28 dosya / 186 test geçti; `npm run build` geçti.
- Canlı toolbox'a (cluster 2 / default 3) proxy üzerinden: `path=/spec/replicas` yalnız ReplicaSet scale değişikliklerini, `attribution=admission`, `kind=Deployment` ve ISO `since`/`until` (milisaniyeli) aralığı doğru sonuç döndü.
- Selenium: pivot namespace/obje filtresini dolduruyor ve detayı açmıyor; tab kapat/aç sonrası filtreler ve "30 days" duruyor.
- `contrast_scan.py` 3 yeni ekranda × 4 tema: 0 hata (bugünün tarihi ilk taramada 2 temada 4.2:1 çıktı → accent metin yerine accent çerçeve yapıldı).
- Test sırasında bulunan hata: boş özel aralıkta Calendar `[null, null]` ile paneli çökertiyordu → `null` geçiliyor.

**Uygularken verdiğim küçük kararlar (onayına sunuyorum):**
- Users görünümünde özel aralık seçiliyse yalnız başlangıç kullanılıyor (users API'sinde `until` yok).
- Pivot ikonları satır hover'ında o satırın tüm pivot hücrelerinde birlikte görünüyor; obje pivotu `resource` + `name` doldurur (`kind` değil).
- Calendar ay/gün adları İngilizce: uygulamada PrimeReact locale tanımı yok (`addLocale` hiç kullanılmamış).
- Zaman sütunu başlığı "Time" olarak kaldı (değer göreli).

**Önceden var olan, bu fazla ilgisiz:** `npm run i18n:check` 10 hata veriyor; hepsi `resourceGraph.issue.podsFailing` (ru/zh/ja), değişiklikten önce de vardı.

## Faz 2 — Obje geçmişi + güvenli rollback (A2, C2, C1, C3, C4)

Mevcut durum: `ResourceListView` satırının ⋮ menüsünde Describe / Port forward var (`describeResource` = plural resource). ChangeDiff tek değişikliğin before/after'ını ya da kayıtlı bir versiyonla canlı objeyi karşılaştırıp `RollbackToolboxChange(side)` ile geri yazabiliyor — "after of change X" zaten "X anındaki hale dön" demek, yani C2 büyük ölçüde UX işi.

**Kararlar:**
- **[ONAY] 2-a** "History" girişi dört yerde: `ResourceListView` ⋮ satır menüsü (Describe/Port forward yanında), YAML/`objectYaml` panel toolbar'ı, pod detay paneli, Describe panel toolbar'ı.
- **[ONAY] 2-b** Yeni **obje zaman çizelgesi paneli** (Dockview tipi `objectHistory`, id `objectHistory:${cluster}:${group}/${resource}:${ns}/${name}`): dikey liste, her satırda zaman/verb/kullanıcı/değişen path'ler; satırlarda A/B seçimi → iki versiyon arası Monaco diff; "Canlıyla karşılaştır"; satırda "Buraya dön". Veri: operatörün `/api/v1/objects/{group}/{version}/{resource}/{ns}/{name}/history` endpoint'i (desktop'ta yeni `GetToolboxObjectHistory`), cursor ile "daha fazla". Diff ve modeller `ChangeDiff.tsx`'teki Monaco kurulumundan (`DIFF_OPTIONS`, `disposeModelsAfterEditor`) ortak bir parçaya çıkarılıp yeniden kullanılır.
- **[ONAY] 2-c** Onay dialogu açılınca otomatik server-side dry-run (`DryRun: []string{metav1.DryRunAll}` ile aynı Update/Create yolu; yeni `DryRunToolboxRollback`). Hata varsa onay butonu devre dışı, neden yazılır.
- **[ONAY] 2-d** Namespace yoksa net hata ("namespace X yok; önce oluşturun"), otomatik oluşturma yok — dry-run bunu dialogda zaten yakalar. Rollback sonrası liste 5 sn arayla en çok 60 sn yoklanır; rollback'in kendi kaydı (fieldManager = kube-ins) görünce satır vurgulanır, sabit 20 sn `setTimeout` kalkar.
- **[ONAY] 2-e** toolbox `ok` değilse girişler görünür ama devre dışı; tooltip'te neden (state'e göre çevrilmiş metin). Durum cluster başına ~60 sn cache'lenir (frontend'de küçük `toolboxStatusStore`; backend'deki endpoint cache'i zaten 60 sn).
- **[ONAY] 2-f** Tek çizelge, isimle eşleşen tüm yaşam döngüleri; UID değiştiği yerde "yeniden oluşturuldu (uid a… → b…)" ayırıcısı.
- **[ONAY] 2-g** Üstte çizelge, altta diff; dikey bölünme + sürüklenebilir tutamaç (yükseklik localStorage'da, `useSplitPane` dikey varyantı gerekirse eklenir).

**Etkilenen dosyalar (Faz 2):** `internal/services/toolboxServices.go` (+history, +dry-run), `internal/business/toolbox.go`, `internal/controller/functionBuilder.go`, `internal/models/toolboxInfo.go`, yeni `frontend/src/components/toolbox/history/ObjectHistoryPanel.tsx`, `ChangeDiff.tsx` (ortak diff parçası + dry-run'lı onay), `contexts/TabContext.tsx` (`openObjectHistory`), `workspace/DockviewContainer.tsx` (kayıt), `shared/ResourceListView.tsx` (⋮ menü), `workspace/ObjectYamlPanel.tsx` / `YamlEditorPanel.tsx` / `DescribePanel.tsx`, `pod/detail/*`, `FloatableTab` serialize (panel params düz veri).

### Faz 2 sonucu (2026-10-29)

**Yapılanlar:**
- Desktop Go: `DryRunToolboxRollback` (services → business → controller); rollback tek fonksiyonda gerçek/dry-run olarak ayrıldı. Re-create'te namespace yoksa "namespace X no longer exists; create it first" hatası. `ToolboxChangeFilter.Group` ("" = tüm gruplar, "core" = core). Testler: `TestRollbackNamesMissingNamespace`, `TestDryRunRollbackWritesNothing`, `TestChangeParamsGroup`.
- Frontend yeni: `history/ObjectHistoryPanel.tsx` (zaman çizelgesi + A/B + "Şu anki hali" satırı + UID ayırıcısı + "Bu hale dön" + altta dikey bölünmüş diff), `history/HistoryButton.tsx`, `history/RollbackDialog.tsx` (otomatik dry-run), `history/YamlDiff.tsx` (ChangeDiff'ten ayrıldı), `history/useRollbackFollowUp.ts`, `stores/toolboxStatusStore.ts`. Testleri: `toolboxStatusStore.test.ts`, `useRollbackFollowUp.test.ts`.
- Değişen: `ChangeDiff` (ortak diff + dry-run'lı dialog), `ClusterHistoryPanel` (sabit 20 sn yerine takip + vurgu), `ResourceListView` ⋮ menüsü, `DescribePanel`, `ObjectYamlPanel`, `YamlEditorPanel`, `PodDetailPanel`, `TabContext.openObjectHistory` (+ panel taşıma), `DockviewContainer`, `FloatableTab`, `ConfirmActionDialog` (`extra`, `confirmDisabled`), `useSplitPane` (`axis: 'y'`), CSS, i18n 6 dil, `capture.py`/`contrast_scan.py` `object-history` senaryosu, `yamlPanelSeed.test.tsx` (panel artık `api.id` okuyor).

**Doğrulama:**
- Go testleri (services/business/controller) geçti; `tsc` temiz; `eslint` 0 hata (1 yeni uyarı: `openObjectHistory`'de dosyadaki diğer açıcılarla aynı `addOptions: any`); `vitest` 30 dosya / 190 test geçti; `npm run build` geçti.
- Selenium, gerçek cluster (default 3): Deployments ⋮ menüsünde "History" → `History whoami` paneli, 8 değişiklik + şu anki hal satırı; A/B diff; "Şu anki haliyle karşılaştır"; "Bu hale dön" → dialogda dry-run "API server kabul ediyor", İptal (**gerçek rollback yapılmadı**). Cluster History'deki rollback dialogunda da dry-run çalışıyor. Pod detay, YAML ve Describe panellerinde "History" butonu var ve aktif; pod detaydan açılan panel kayıt yoksa boş durum mesajı gösteriyor.
- `contrast_scan.py` object-history + cluster-history + toolbox × 4 tema: 0 hata.
- Test sırasında düzeltilen: aynı saniyedeki değişikliklerin A/B etiketleri ayırt edilemiyordu → etikete kullanıcı eklendi; başlıkta ikon metne yapışıktı.

**Uygularken verdiğim kararlar (onayına sunuyorum):**
- Plandaki `/objects/.../history` endpoint'i yerine `/changes?resource=&namespace=&name=[&group=]` kullanıldı: Describe ve liste menüsü yalnız plural resource biliyor (grup bilinmiyor); history endpoint'i grubu zorunlu tutuyor. Sonuç aynı, sadece grup bilinmeyen girişlerde grup filtresi yok.
- Zaman çizelgesindeki karşılaştırmalar (A/B ve canlı) restorable formda (status, managedFields, resourceVersion yok) — rollback'in yazacağıyla birebir.
- "Bu hale dön" yalnız create/update satırlarında; delete/finalized satırlarında yok (silinmiş objeyi geri getirmek için silinmeden önceki son satır kullanılıyor). Secret satırlarında devre dışı.
- İlk açılışta B = en yeni değişiklik, A = bir öncesi; tek değişiklik varsa B = şu anki hal.
- Liste ⋮ menüsünde toolbox durumu henüz bilinmiyorsa "History" aktif kalıyor; panel kendisi sorunu söylüyor.
- Rollback takibinde rollback kaydı field manager `kube-inspector` + aynı obje + rollback zamanından en fazla 5 sn önce olarak tanınıyor (cluster saati farkı için).
- Rollback kaydı vurgusu `--ok` renginde (seçili satırın `--accent`'inden ayrılsın diye).

**Test edilemeyen:** eksik namespace senaryosu canlıda denenmedi (cluster'da silinmiş namespace'li kayıt yok); Go testiyle doğrulandı. toolbox'ın kurulu olmadığı cluster'da devre dışı görünüm canlıda denenmedi (cluster değiştirmek paylaşılan `.active` dosyasını yazar).

## Faz 3 — Kayıt sağlığı (E1, D1, D2)

Not: API her replikadan servis ediliyor ama pending/dropped sayaçları yalnız ilgili sürecin belleğinde (Prometheus); leader'ın bilgisi Lease objesinde. Bu yüzden sağlık bilgisinin kaynağı ClickHouse + Lease olmalı, süreç sayaçları değil.

**Kararlar:**
- **[ONAY] 3-a** Heartbeat tablosu: leader periyodik olarak `recorder_heartbeats` (cluster, identity, ts, watched_resources, pending) satırı yazar (yeni migration `0002_heartbeats.sql`, kısa TTL); eşiği aşan aralıklar SQL'de boşluk; yeni `GET /api/v1/gaps?since=`.
- **[ONAY] 3-b** Boşluklar üç yerde: History changes listesinde zaman sırasına yerleşen şerit satırı, obje zaman çizelgesinde ayırıcı, ToolboxPanel'de kapsama özeti (son 7 gün % + son boşluk).
- **[ONAY] 3-c** ToolboxPanel sağlık içeriği: (1) kaynak bağlantıları — admission/audit son hint zamanı (`actor_hints` max(ts) by source), audit yoksa "kaynak IP / user agent yok" açıklaması; (2) leader kimliği + başlangıcı (Lease) ve izlenen resource sayısı (heartbeat); (3) son 24 saat attribution dağılımı; (4) yapılandırma — retention, recordStatusChanges, exclude listeleri.
- **[ONAY] 3-d** Kurulu değilken yalnız kurulum rehberi (kopyalanabilir komutlar + audit adımları). Web UI kısayolu yok.
- **[ONAY] 3-e** Yeni `GET /api/v1/health` (tek çağrı: sources, leader, coverage, attribution dağılımı, config); `/info` değişmez. 404 → desktop "sağlık bilgisi için toolbox'ı güncelleyin" der, geri kalan her şey çalışır.
- **[ONAY] 3-f** Heartbeat 15 sn, boşluk eşiği 45 sn; ikisi de Helm values / config'den ayarlanabilir (`recorder.heartbeatInterval`, `recorder.gapThreshold`).
- **[ONAY] 3-g** ToolboxPanel'de history satırının altında katlanabilir "Kayıt sağlığı" bölümü; bir sorun (audit hiç yok, son 24 saatte boşluk, leader yok) varsa açık gelir.
- **[ONAY] 3-h** Chart OCI olarak yayınlanır (registry 3-i ile `ghcr.io/opensourcemonkeys` oldu): CI `oci://ghcr.io/opensourcemonkeys/charts/toolbox`'a push eder; rehber `helm install toolbox oci://ghcr.io/opensourcemonkeys/charts/toolbox …` gösterir. Cluster adı rehberde kube-ins cluster adıyla önceden doldurulur.

**Etkilenen dosyalar (Faz 3):** operatör `internal/store/migrations/0002_*.sql`, `internal/store/{writer,query}.go`, yeni heartbeat döngüsü (`cmd/toolbox/main.go` lead fonksiyonu), `internal/api/api.go` (+health, +gaps, testleri), `internal/config/config.go`, Helm `values.yaml`/`configmap.yaml`/`rbac.yaml` (Lease get zaten var mı kontrol), `README.md`; desktop `toolboxServices.go`/`business`/controller/models (+health, +gaps), `ToolboxPanel.tsx`, `ClusterHistoryPanel.tsx` (şerit), `ObjectHistoryPanel.tsx` (ayırıcı).

### Faz 3 sonucu (2026-10-29)

**Yapılanlar — operatör (`toolbox/`):**
- `0002_heartbeats.sql`: `recorder_heartbeats` (TTL 30 gün); `config.Recorder` (heartbeatInterval 15s, gapThreshold 45s, doğrulamalı) + `config.Sources` (admission/audit açık mı).
- Leader'da heartbeat döngüsü (`cmd/toolbox/main.go::heartbeat`, `safego.Go`); izlenen resource sayısı `Watcher.Watched()`, bekleyen değişiklik `Correlator.Pending()`.
- `store/health.go`: `WriteHeartbeat`, `LastHeartbeat`, `Coverage` (ClickHouse `lagInFrame` window fonksiyonu; baştaki, aradaki ve hâlâ süren boşluk), `LastHints`, `AttributionCounts`.
- `api/health.go`: `GET /api/v1/health` (her parça bağımsız; biri hata verirse o parça boş kalır), `GET /api/v1/gaps`. Lease, her replikadan API server üzerinden okunuyor.
- Helm: `recorder.*` values, configmap'e `recorder` + `sources`. Image adresi `ghcr.io/opensourcemonkeys/toolbox`. Dockerfile cross-compile (`--platform=$BUILDPLATFORM`, QEMU gerekmez).
- `.github/workflows/toolbox.yml`: branch push'ta test (vet, unit, store testleri gerçek ClickHouse ile, helm lint), `toolbox-v*` tag'inde amd64+arm64 image + chart OCI push. Yeni üçüncü taraf action yok: yalnızca repoda zaten SHA'yla sabitli olan checkout/setup-go; buildkit ve helm imajları digest ile sabit.
- README: OCI kurulum, yeni endpoint'ler, "Recording gaps", "Releases".
- Testler: `store/health_test.go` (gerçek ClickHouse), `api` TestHealth/TestGaps, `config` TestRecorderConfig.

**Yapılanlar — desktop:**
- Go: `GetToolboxHealth`, `GetToolboxGaps` (services/business/controller, modeller). toolbox'ın kendi 404'ü "eski sürüm" sayılıyor (`ToolboxError.Code`). Testler: `TestToolboxHealth`, `TestToolboxHealthOnOldToolbox`.
- Frontend: `toolbox/RecordingHealth.tsx` (katlanabilir, sorun varsa açık; satırlar: admission, audit, leader, 7 günlük kapsama, son 24 saat atama dağılımı, ayarlar), `toolbox/InstallGuide.tsx` (cluster adı shell için tırnaklı), `history/gaps.tsx` (`useRecordingGaps`, `withGaps`, `GapText`, `formatDuration`); boşluk şeritleri Cluster History listesinde, ayırıcılar obje zaman çizelgesinde. i18n 6 dil (çoğul biçimler dahil). Testler: `gaps.test.ts`, `InstallGuide.test.tsx`.

**Doğrulama:**
- toolbox: `go vet`, `make test`, `make test-store` (Coverage testlerinin gerçekten koştuğu `-v` ile teyit edildi), `helm lint` + `helm template` (dockerize helm), arm64 image'ın yerelde cross-build edilmesi — hepsi geçti.
- Desktop: Go testleri, `tsc`, `eslint` (0 hata), `vitest` 32 dosya / 194 test, `npm run build`.
- Canlı (eski toolbox'lu cluster): ToolboxPanel'de "Bu toolbox sürümü sağlık bilgisi vermiyor" mesajı, History'de hata yok ve boşluk satırı yok — geriye uyumluluk çalışıyor.
- Yeni toolbox ile görünüm: health ve gaps çağrıları tarayıcıda örnek veriyle taklit edilerek render edildi (gerçek bir yeni toolbox kurulu değil). Bu ekranlarda kontrast taraması 4 temada 0 hata.
- Test sırasında düzeltilen: boşluk varken kapsama %100.0 görünüyordu (artık aşağı yuvarlanıyor); boşluk şeridinin uzun metni Object sütununu genişletiyordu.

**Uygularken verdiğim kararlar (onayına sunuyorum):**
- Heartbeat TTL'i 30 gün (7 günlük kapsamadan uzun, audit_raw ile aynı).
- Kapsama, kaydedilmiş ilk heartbeat'ten itibaren sayılıyor: heartbeat'i olmayan eski sürümden yükseltilen toolbox geçmişini "boşluk" diye raporlamıyor.
- Heartbeat'i 60 sn'den eski olan leader "sorunlu" sayılıyor (lease hâlâ onu gösterse bile).
- Sorun sayılanlar: audit/admission'dan son 24 saatte hiç hint gelmemesi (uyarı), son 24 saatte bir boşluk (uyarı), süren boşluk ya da leader olmaması (hata). Audit'in kapalı olması sorun sayılmıyor, yalnız not düşülüyor.
- Image için `latest` tag'i push edilmiyor; yalnız sürüm tag'i.
- Cluster History'de "tüm zamanlar" seçiliyken boşluklar son 30 gün için isteniyor (heartbeat saklama süresi).
- toolbox testleri (CI) main dışındaki her branch push'unda koşuyor; `paths` filtresi tag tetikleyicisiyle birlikte kullanılamadığı için konmadı.

**Senin yapman gerekenler:**
- İlk `toolbox-v*` release'inden sonra GHCR'da `toolbox` image'ını ve `charts/toolbox` paketini public yapmak (GHCR yeni paketleri private açar; aksi halde rehberdeki `helm install` login ister).
- Yeni toolbox'u cluster'ına kurmak, uçtan uca (gerçek heartbeat ve boşluklar) denemek için gerekiyor; cluster'ında değişiklik yapacağı için ben kurmadım.

## Faz 4 — Genel bakış (A1 stats)

Operatör `GET /api/v1/stats?since=&bucket=` zaten var: zaman kovası × verb sayıları + top 10 resource/user/namespace. Grafik için `lib/LiveChart.tsx` (chart.js, lazy) mevcut.

**Kararlar:**
- **[ONAY] 4-a** History panelinde 4. görünüm: Segmented "Genel bakış · Değişiklikler · Reddedilen · Kullanıcılar"; since + namespace filtrelerini paylaşır.
- **[ONAY] 4-b** İçerik: verb'e göre yığılmış aktivite grafiği (sütuna tıklayınca o aralığın Changes'ı), top 10 resource/kullanıcı/namespace (tıklayınca filtreli Changes), özet kartlar (toplam, delete, reddedilen, none oranı — önceki dönemle kıyas), grafikte kayıt boşlukları taralı bant.
- **[ONAY] 4-c** Panel açılışında varsayılan görünüm Genel bakış (oturum store'unda seçili görünüm varsa o).
- Türetilen ihtiyaç: özet kartlar için `/api/v1/stats` yanıtına `totals` (changes, deletes, unattributed, attempts) ve `previous` (aynı uzunlukta önceki dönem) eklenmeli — operatör değişikliği. Kova genişliği aralıktan otomatik seçilir → **karar 4-d**.
- Grafik kodu yazılmadan önce `dataviz` skill'i yüklenecek (renkler `--cat-*`/verb tonlarıyla uyumlu, tema token'larından).

- **[ONAY] 4-d** Kova genişliği otomatik (1h→1m, 24h→1h, 7d→6h, 30d→1d, özel aralık → ~48 sütun) + grafik köşesinde elle seçim. `/stats` genişletmesi (totals + previous) bu fazda.

- **[ONAY] 4-e** Verb renkleri mevcut `--cat` token'ları, validator'ın geçtiği sırayla: create `--cat-6`, update `--cat-2`, delete `--cat-4`, finalized `--cat-1` (CVD ΔE ≥ 14, normal görüş ≥ 15). Doygunluk tabanı uyarısı bilinçli kabul; kimlik ayrıca lejant, tooltip ve tablo ile.

### Faz 4 sonucu (2026-10-29)

**Yapılanlar:**
- Operatör: `store.Stats(StatsFilter{Cluster, Namespace, Since, Until, Bucket})` — `totals` (changes, deletes, unattributed, refused writes) ve aynı uzunluktaki önceki dönem için `previous`. API: `until`, `namespace`; 2000'den fazla sütun ya da `until ≤ since` 400 döner. Testler: `TestStatsParams` (api), store testinde toplamlar ve namespace filtresi (gerçek ClickHouse).
- Desktop Go: `GetToolboxStats` (eski toolbox'ta `Totals`/`Previous` nil). Test: `TestToolboxStats` (yeni ve eski toolbox).
- Frontend: `history/HistoryOverview.tsx` (4 kart + önceki dönemle kıyas, verb'e göre yığılmış aktivite grafiği, tablo görünümü, 3 top liste, kayıt boşlukları grafikte taralı bant), `history/buckets.ts` (+ testi). `historyStore` varsayılan görünümü `overview`, `bucket` alanı. `LiveChart`'a `plugins` desteği. Genel bakışta filtre satırı yalnız namespace + zaman. i18n 6 dil. `capture.py`'ye `history-overview` senaryosu (diğer history senaryoları önce Changes'a geçiyor).

**Doğrulama:**
- toolbox `go vet`, `make test`, `make test-store`; desktop Go testleri; `tsc`, `eslint` (0 hata, yeni uyarı yok), `vitest` 33 dosya / 197 test, `npm run build`.
- Canlı (eski toolbox): genel bakış gerçek veriyle grafik ve top listeleri gösteriyor, kartların yerinde "güncelleyin" notu. Resource listesinden tıklama → Changes `resource=deployments`; tablo satırından tıklama → o sütunun özel aralığı.
- Yeni toolbox görünümü (kartlar + boşluk bandı) örnek veriyle render edildi; kontrast taraması 4 temada 0 hata.
- Test sırasında düzeltilen: boş kullanıcı + boş field manager "()" görünüyordu → "(Bilinmiyor)"; drill önceden kalmış gizli liste filtrelerini taşıyordu (135'lik sütun 29 satır açıyordu).

**Uygularken verdiğim kararlar (onayına sunuyorum):**
- Genel bakıştan drill yapınca genel bakışta görünmeyen liste filtreleri (arama, resource, kind, name, user, verb, attribution, path) temizleniyor; namespace ve zaman korunuyor.
- "Tüm zamanlar" genel bakışta 90 gün (varsayılan saklama süresi), sütun 24 saat.
- Önceden kalmış manuel sütun genişliği yeni aralığa sığmıyorsa otomatik genişliğe dönülüyor.
- Top listede resource tıklaması yalnız plural'ı (`deployments.apps` → `deployments`) filtreye yazıyor; field manager satırları (`(helm)`) ve cluster geneli namespace tıklanamıyor (karşılık gelen filtre yok).
- Kartlarda değişim yönü yalnız ▲/▼ ve metinle, renksiz (sakin tasarım; artışın iyi mi kötü mü olduğu kartına göre değişiyor).
- Atanamayan kartında değer yüzde, kıyas önceki dönemin yüzdesi.
- Tablo görünümü yalnız boş olmayan sütunları listeliyor.
- Genel bakış 60 sn'de bir yenileniyor (liste görünümleri 15 sn).

## Faz 5 — Attempts / Users / Export (E3, B3, B4, B6)

**Kararlar:**
- **[ONAY] 5-a** Export CSV + JSON, mevcut filtrenin tüm sonucu (cursor ile sayfa sayfa, üst sınır 50.000 satır; sınıra takılırsa kullanıcıya söylenir). Kayıt `Transport.SaveFile` ile native dialog (mevcut `SaveReport` yolu). JSON'da patch var, before/after yok. Changes ve attempts görünümlerinde.
- **[ONAY] 5-b** Attempts: operatöre cursor (`(ts, audit_id)` anahtarı, changes ile aynı kodlama) + "Daha fazla"; satır tıklayınca sağda detay paneli (requestUri, user agent, gruplar, impersonation, tam mesaj) — Changes ile aynı split.
- **[ONAY] 5-c** Users: her kullanıcı için create/update/delete(/finalized) sayıları (operatör `Users` sorgusuna `countIf` sütunları). Gruplar, "tüm zamanlar" düzeltmesi ve SA ayrımı **kapsam dışı** (87600h davranışı kalır).

### Faz 5 sonucu (2026-10-29)

**Yapılanlar:**
- Operatör: attempts'e `(ts, audit_id)` cursor'ı (`ORDER BY ts DESC, audit_id DESC`, audit ID string olduğu için ayrı kodlama), API `cursor` + `nextCursor`; `Users`'a `creates/updates/deletes/finalized` (`countIf`). Testler: `TestAttemptsPage` (api), `TestAttemptsCursor` (aynı zaman damgalı kayıtlarda sayfa sınırı, gerçek ClickHouse), Users verb toplamları.
- Desktop Go: `GetToolboxAttempts` artık sayfa döndürüyor (`ToolboxAttemptPage`), attempt modeline groups/requestUri/auditId; `ToolboxUser` verb sayıları; yeni `services/toolboxExportServices.go` (1000'lik sayfalarla 50.000'e kadar, CSV + JSON) ve `App.ExportToolboxHistory` (önce kaydetme dialogu, sonra çekme). Testler: `TestExportPagesAndLimits`, `TestCSVCell`.
- Frontend: Rejected görünümünde "Daha fazla" + satır tıklayınca sağda `history/AttemptDetail.tsx` (istek satırı, gruplar, user agent, audit ID, tam sunucu yanıtı); Users'ta create/update/delete/finalized sütunları (eski toolbox'ta "—"); Changes ve Rejected toolbar'ında "Dışa aktar ▾" (CSV / JSON), sonuç toast'ı (kesildiyse uyarı). i18n 6 dil (çoğul biçimler dahil).

**Doğrulama:**
- toolbox `go vet`, `make test`, `make test-store`; desktop Go testleri; `tsc`, `eslint` (0 hata, yeni uyarı yok), `vitest` 33 dosya / 197 test, `npm run build`.
- Canlı (eski toolbox): Changes CSV dışa aktarma 135 satır, 20 sütun, tüm satırlar aynı sütun sayısında (dev modda native dialog olmadığından `~/Downloads`'a yazıldı; test dosyası silindi). Users'ta eski toolbox için "—". Cluster'da reddedilmiş istek olmadığından Rejected canlıda boş.
- Örnek veriyle: Rejected "Daha fazla" ile 5 → 8 satır, detay paneli; Users verb sayıları. Kontrast taraması 4 temada 0 hata.

**Uygularken verdiğim kararlar (onayına sunuyorum):**
- Dışa aktarma önce dosya yerini soruyor, sonra veriyi çekiyor (iptal edilen export için hiç istek yapılmıyor); çekme sırasında buton yükleniyor durumda.
- JSON çıktısı `{view, exportedAt, truncated, items}` nesnesi; `items` toolbox'ın kayıtları olduğu gibi (patch dahil, before/after yok).
- CSV'de formül koruması: `= + - @` (ve tab/CR) ile başlayan hücrelerin başına `'` ekleniyor. Çok değerli alanlar (gruplar, IP'ler, değişen path'ler) tek hücrede boşlukla ayrılıyor.
- Export'un toplam süresi en çok 3 dakika.
- Dosya adı `<cluster>-<görünüm>-<YYYYMMDD-HHMMSS>.<csv|json>`.
- Eski toolbox'ta attempts sayfalanmadığı için export ilk sayfayla sınırlı kalıyor.
- Users görünümünde verb sütun başlıkları listedeki verb lambalarıyla aynı (çevrilmeden, veri olarak).

## Faz 6 — ClickHouse performansı (E2)

**Kararlar:**
- **[ONAY] 6-a** Bilinen iyileştirmeler doğrudan yapılır; ölçüm yalnız doğrulama için:
  - `changes` için `event_time` sıralı projection (`ORDER BY (cluster, event_time, event_id)`) → newest-first liste ve cursor sayfalama.
  - `q` araması için name/namespace/username/kind üzerinde `ngrambf_v1` skip index.
  - `FINAL` maliyeti: `do_not_merge_across_partitions_select_final=1` (partition = ay, event_id tek partition'da kalır) ayarı sorgulara eklenir.
  - Yeni migration `0003_perf.sql` (+ `MATERIALIZE PROJECTION/INDEX` mevcut veriye).
- **[ONAY] 6-b** Hedef: 50 milyon satır, < 2 sn (list, q, stats, object history). Doğrulama `make test-store`'a eklenen, sentetik veri yükleyen bir benchmark testiyle (`-tags bench`).

**Ölçüm sonrası revizyon (2026-10-29):** 50M satırlık benchmark plandaki üç varsayımı çürüttü:
- Projection'lar `FINAL`'lı sorgularda kullanılmıyor.
- `do_not_merge_across_partitions_select_final` ve skip index'ler etkisiz, çünkü sıralama anahtarı resource/namespace/name ile başlıyor ve her granül tüm zamana yayılıyor.
- `FINAL` yerine `LIMIT 1 BY` tüm zaman aralığında bellek sınırına takılıyor.
6-a ve 6-b bu yüzden aşağıdaki kararlarla değişti.
- **[ONAY] 6-c** Liste sorguları (1.2–2.1 sn) olduğu gibi kalır; şema aynı.
- **[RET] paralel stats**: ölçüldü, daha yavaş (2.75 → 3.45 sn; her `FINAL` sorgusu zaten tüm çekirdekleri kullanıyor) — geri alındı.
- **[ONAY] 6-d** Genel bakış için saatlik ön-toplama tablosu.
- **[ONAY] 6-e** Faz 6 içinde yapılır.
- **[ONAY] 6-f** Karma okuma: tam saatler toplama tablosundan; kenardaki kısmi saatler ve 24 saatten kısa aralıklar ham `FINAL` sorgusundan. Sonuçlar her zaman kesin.
- **[ONAY] 6-g** Correlator tek seferde yazar: atanamayan değişiklik retry süresi dolana kadar bellekte bekler, ikinci versiyon yazılmaz; toplama materialized view ile. Desktop'taki rollback takibi 60 → 120 sn.
- **[ONAY] 6-h** Geçmiş veri aktarılmaz; toolbox toplamanın başladığı anı kaydeder, ondan önceki dönemler ham sorguyla okunur.
- `make bench-store` (`-tags bench`, 50M satır) ölçüm raporu olarak kalır.

### Faz 6 sonucu (2026-10-29)

**Ölçüm (50M satır, `make bench-store`, ClickHouse 25.8, 10 çekirdek):**

| Sorgu | Önce | Sonra |
|---|---|---|
| genel bakış 7 gün | 4.94 s | **0.36 s** |
| genel bakış 90 gün | 7.47 s | **0.40 s** |
| liste 24 sa / 30 gün / tümü | 1.5 / 2.5 / 2.4 s | değişmedi (6-c) |
| `q` araması 30 gün | 2.5 s | değişmedi |
| obje geçmişi | 0.02–0.04 s | değişmedi |

**Yapılanlar:**
- Correlator her değişikliği bir kez yazıyor: hint bulamayan değişiklik retry'a kadar bellekte bekliyor, ikinci versiyon yazılmıyor; kapanışta bekleyenler yazılıyor. Testler güncellendi ve eklendi (`TestUnmatchedWaitsForRetryAndIsWrittenOnce`, `TestStillUnattributedIsWrittenWithFallback`, `TestShutdownFlushesHeldRetries`; hint seçimi testlerinin amacı korunarak yeni zamanlamaya uyarlandı).
- `0003_hourly_rollup.sql`: `changes_hourly` (SummingMergeTree; saat, namespace, verb, attribution, resource, aktör), `version = 1` sayan materialized view, başlangıç anı için `rollup_state`. Saklama süresi `changes` ile aynı (`EnsureRetention`).
- `store/rollup.go`: karma okuma (tam saatler toplama tablosundan, kenarlar `changes`'tan tek taramada ve `FINAL`'sız); pencere toplama tablosunun başlangıcından eskiyse, bir günden kısaysa ya da sütun bir saatten darsa eski yol. `topN`'e eşitlik durumunda anahtar sırası eklendi (iki yol aynı sırayı versin diye).
- `store/rollup_test.go`: karma sonucun, saat ortasında başlayıp biten pencerelerde ve namespace filtresiyle ham sonuçla birebir aynı olduğu (gerçek ClickHouse), ve hangi pencerelerin eski yola düştüğü.
- `store/bench_test.go` (`-tags bench`) + `make bench-store`: 50M satır (5M'lik parçalarla), aktörün resource/namespace'e bağlı olduğu gerçekçi dağılım, merge'lerin bitmesini bekliyor, her okumayı ölçüyor.
- Desktop: rollback takibi 60 → 120 sn (+ test). README (yazma davranışı, "Overview statistics", bilinen sınırlama, `bench-store`), Helm `retryAfter` açıklaması, CLAUDE.md.

**Geri alınan / elenen:** paralel stats (ölçüldü: daha yavaş), bağlantı havuzunu büyütme (gereği kalmadı), projection, `do_not_merge_across_partitions_select_final`, `ngrambf` index'i (ölçüldü: etkisiz ya da `FINAL` ile kullanılamıyor).

**Doğrulama:** toolbox `go vet` (bench etiketiyle de), `make test`, `make test-store`, `helm lint`; desktop Go testleri, `tsc`, `eslint`, `vitest` 197 test, `npm run build`.

**Uygularken verdiğim kararlar (onayına sunuyorum):**
- Karma yol yalnız pencerenin tamamı toplama tablosunun başlangıcından sonraysa kullanılıyor; yükseltmeden sonraki ilk günlerde uzun pencereler eski yoldan okunuyor (6-h'nin sonucu: geçmiş aktarılmadı).
- Kenar saatleri `FINAL`'sız ve `version = 1` ile okunuyor (materialized view ile aynı kural); yükseltme sırasında eski bir leader'ın yazdığı ikinci versiyonlar sayılmıyor.
- Toplama tablosunun boyutları: saat, namespace, verb, attribution, resource (`resource.group`), aktör (kullanıcı ya da `(field manager)`). Benchmark verisinde 50M değişiklik için 27M satır; gerçek cluster'da aktör–resource bağı daha güçlü olduğundan daha az beklenir.
- Benchmark verisi uniform rastgele değil: aktör resource/namespace'ten, attribution aktörden türetiliyor (uniform veri her toplama satırını tekil yapar, hiçbir cluster öyle değildir).

**Bilinen yan etki:** atanamayan değişiklikler listede ~15 sn yerine ~90 sn sonra görünüyor; leader sert biçimde ölürse (OOM, node kaybı) retry bekleyen en çok 90 sn'lik atanamayan değişiklik kaybolabiliyor (önceden yazılmış olurdu). README'de belgelendi.

## Faz 7 — Web UI, TUI, canlı akış (E4, F1, E5)

**Kararlar:**
- **[ONAY] 7-a** Gömülü web UI kaldırılır: `toolbox/internal/web/` silinir, `cmd/toolbox/main.go`'daki `GET /` kaydı kalkar, README'nin UI bahisleri ve paket açıklaması güncellenir. Operatör yalnız API + webhook + health/metrics sunar.
- **[ONAY] 7-b** TUI: yeni `history` view (changes tablosu, namespace/user/verb/since filtreleri, sayfalama) + rollback (onay + dry-run). `internal/tui/registry.go` deseni; business'taki toolbox fonksiyonları doğrudan kullanılır (Wails yok).
- **[ONAY] 7-c** SSE polling'in yerine geçer: operatöre `GET /api/v1/changes/stream` (aynı filtreler, yeni satırlar yazıldıkça; heartbeat yorum satırları), desktop backend proxy üzerinden `Stream()` ile okuyup `toolbox:changes:${sessionId}` event'i yayar (oturum kayıt defteri = ownership-token kuralı, `safego.Go`). Changes ilk sayfadayken aktif; kopunca 15 sn polling'e döner. Re-attribution (aynı event_id'nin yeni versiyonu) satırı yerinde günceller.
- **[ONAY] 7-d** TUI'da ayrı detay görünümü yok; rollback onay modalı kısa özet gösterir: obje, zaman, kullanıcı, değişen path'ler, dry-run sonucu.

### Faz 7 sonucu (2026-10-29)

**Yapılanlar:**
- 7-a: `toolbox/internal/web` silindi (index.html, app.js, style.css, web.go), `GET /` route'u kalktı; README ve paket açıklamaları güncellendi.
- 7-c operatör: `GET /api/v1/changes/stream` (SSE). Her replika ClickHouse'u 2 sn'de bir yokluyor; geri bakış `delay + retryAfter + 1m` (geç yazılan değişiklik kaçmasın diye), gönderilen `event_id`'ler hatırlanıyor; 15 sn'de bir keepalive. `store.RecentChanges`: önce yalnız ID'ler, sonra yalnız yenilerin tamamı; `FINAL`'sız, `version = 1` (Faz 6'daki yazma-bir-kez sayesinde). `ListChanges`'in filtreleri `changeFilterWhere`'e ayrıldı. Testler: `TestStreamSendsEachChangeOnce`, `TestStreamRouteDoesNotShadowChangeID` (api), `TestRecentChanges` (gerçek ClickHouse).
- 7-c desktop: `services/toolboxStreamServices.go` (SSE ayrıştırıcı, streaming client), `App.StartToolboxStream`/`StopToolboxStream` (cancelRegistry; `done` artık sahipliği döndürüyor, bitiş olayını yalnız hâlâ sahip olan yayar), `toolbox:change:`/`toolbox:stream-end:` olayları. Frontend: `history/useChangeStream.ts`, `history/mergeChange.ts`; akış canlıyken polling kapalı, toolbar'da "Canlı" lambası; sekme arka plandan dönünce bir kez yenileme. Testler: `TestStreamToolboxChanges`, `useChangeStream.test.ts`.
- 7-b/7-d TUI: `internal/tui/history.go` (CLUSTER ▸ Cluster History): `F` filtre (`namespace= user= verb= since=`, `7d` yazılabilir, `since=all`), `M` sonraki sayfa, `U` geri al (önce dry-run; reddedilirse sebep gösterilir, kabul edilirse obje/değişiklik/kullanıcı/path/dry-run sonucunu içeren onay). Liste ekranına `rowAction.custom`, `resourceDef.noDescribe`/`hints`. Testler: `TestParseHistoryFilter`, `TestHistoryRow`. TUI Wails'siz kaldı.

**Doğrulama:**
- toolbox `go vet`, `make test`, `make test-store`; desktop Go testleri (services, business, controller, tui); `tsc`, `eslint`, `vitest` 34 dosya / 201 test, `npm run build`.
- Canlı TUI (tmux, gerçek cluster): Cluster History açılıyor, `F` ile `since=7d ns=ingress-test` sunucuda uygulanıp 20 satır geldi, breadcrumb ve başlık filtreyi gösteriyor; `U` dry-run'ı çalıştırıp özetli onayı açtı. **Onay verilmedi** (TUI oturumu tuş gönderilmeden kapatıldı); whoami deployment'ının managedFields'ı bugün kube-inspector yazması olmadığını doğruladı.
- Canlı GUI (eski toolbox): akış 404 ile bitti, liste 15 sn polling'e döndü, "Canlı" lambası çıkmadı, hata yok; filtre değişiminde akış durdurulup yeniden denendi.
- Canlıda denenemeyen: yeni toolbox'ta gerçek SSE akışı (cluster'daki toolbox eski sürüm); TUI'de `M`'nin sonraki sayfası (20 satırlık sonuçta tek sayfa vardı) ve create satırında `U` uyarısı (birim olarak değil, kod yoluyla).

**Uygularken verdiğim kararlar (onayına sunuyorum):**
- Akış her replikada ClickHouse yoklamasıyla çalışıyor (yalnız leader yazdığı için süreç içi bir yayın kaynağı yok); yoklama 2 sn, partiler 500 değişiklik.
- Akış açılışta tüm geri bakış penceresini gönderiyor, istemci `eventId` ile tekilleştiriyor (liste çekimi ile akış açılışı arasında yazılanlar kaçmasın).
- Akış yalnız Changes'ın ilk sayfasında ve aralık "şimdi"ye uzanıyorken açık; obje zaman çizelgesi 15 sn polling'de kaldı (plan 7-c yalnız Changes diyordu).
- Akış bir kez düştüğünde aynı filtre için yeniden denenmiyor (polling sürüyor); filtre değişince ya da panel yeniden açılınca tekrar deneniyor.
- TUI'de undo "bu değişikliği geri al" anlamında: değişiklikten **önceki** sürümü yazıyor; create satırında yapılamıyor.
- TUI filtresi cluster değişince korunuyor (yalnız yüklü sayfalar sıfırlanıyor).

## Faz 3'e ek — toolbox CI
- **[ONAY]** Yeni `.github/workflows/toolbox.yml`: `toolbox/` testleri (`make test`, `helm-lint`), multi-arch image build/push `ghcr.io/opensourcemonkeys/toolbox`, chart OCI push `oci://ghcr.io/opensourcemonkeys/charts/toolbox`. Tetikleyici ayrı tag deseni `toolbox-v*` (app'ten bağımsız sürüm); chart `appVersion` tag'den set edilir. Faz 3'ün kurulum rehberi bu yayına dayanır, bu yüzden Faz 3 içinde yapılır.
- **[ONAY] 3-i** Registry: `ghcr.io/opensourcemonkeys` (repo sahibi; CI'daki GITHUB_TOKEN yeterli). Mimari: linux/amd64 + linux/arm64.

## Faz 8 — Dokümantasyon
- **[ONAY]** MkDocs'a yeni "Cluster history (toolbox)" sayfası (`description:` front-matter'lı, nav'a eklenir): kurulum (OCI helm), audit webhook adımları, ekranlar (`scripts/ui/docs_shots.py` ile ekran görüntüleri), managed cluster sınırlamaları, rollback semantiği. ToolboxPanel'deki kurulum rehberi bu sayfaya bağlanır. `toolbox/README.md` ve kök `CLAUDE.md`'nin toolbox bölümleri her fazda değişen davranışa göre güncellenir.

### Faz 8 sonucu (2026-10-30)

**Kararlar:**
- **[ONAY] 8-a** Ekran görüntüleri gerçek veriyle, cluster'daki toolbox güncellendikten sonra.
- **[ONAY] 8-b** Sitede ayrı "Toolbox" bölümü, dört sayfa.
- **[ONAY] 8-c** CHANGELOG.md'ye dokunulmadı (release sırasında kullanıcı yazar).

**Toolbox güncellemesi ("default 3", onaylı adımlarla):**
- Eski image `localhost:5000/toolbox:prev` olarak saklandı.
- Yeni image (`v0.19.0-beta-3-g99fba62-toolbox-plan`) `:dev` olarak push edildi.
- `rollout restart deploy/toolbox` yapıldı. helm upgrade yapılmadı (chart'ın varsayılan image adresi artık ghcr).
- 0002 ve 0003 migration'ları uygulandı, leader alındı.
- Canlı doğrulandı: `/api/v1/health` gerçek veri döndürüyor; SSE akışı API proxy üzerinden 75 sn'de 7 tekil değişiklik ve 4 keepalive verdi; uygulamada Changes'ta "Canlı" lambası yanıyor.
- **Geri dönüş:** `docker tag localhost:5000/toolbox:prev localhost:5000/toolbox:dev && docker push localhost:5000/toolbox:dev && kubectl -n toolbox rollout restart deploy/toolbox`.

**Yapılanlar:**
- `docs/toolbox/index.md` (ne kaydettiği, OCI ile kurulum, audit webhook adımları, managed cluster'lar, Kube Inspector'ın ihtiyaç duyduğu RBAC, yükseltme).
- `docs/toolbox/cluster-history.md` (genel bakış, filtreler, pivot, canlı akış, Rejected, Users, export).
- `docs/toolbox/object-history.md` (A/B karşılaştırma, rollback semantiği: dry-run, replace + resourceVersion, yeniden oluşturma, Secret ve controller sınırları; TUI tuşları).
- `docs/toolbox/recording-health.md` (satırlar, kayıt boşlukları, geç görünen değişiklikler, sert kapanmada kayıp).
- `mkdocs.yml` nav'ına "Toolbox" bölümü.
- `docs_shots.py`'ye dört sahne; görüntüler `docs/assets/screenshots/`'a kopyalandı (toolbox-health, history-overview, history-changes, object-history).
- Kurulum rehberine (`InstallGuide.tsx`) dokümana giden "Kurulum rehberinin tamamı" bağlantısı (6 dil).

**Doğrulama:** `make docs-build` (`--strict`) uyarısız geçti (yalnız Material'ın MkDocs 2.0 duyurusu); dört sayfa `site/toolbox/` altında ve `llms.txt`'de. Frontend `tsc`, `eslint`, `vitest`, `npm run build` geçti.

**Gözlem (düzeltilmedi, bilgi):** Cluster'daki kayıt sağlığı "Admission webhook: son 24 saatte hiç gelmedi" diyor; son günlerin atamaları yalnız managedFields/none. Admission webhook'u bu cluster'da istek almıyor olabilir — ayrıca incelenmeye değer.

### Sonrası: registry adları (2026-10-30)
- **[ONAY]** Image `ghcr.io/opensourcemonkeys/kube-inspector-toolbox`, chart `oci://ghcr.io/opensourcemonkeys/charts/kube-inspector-toolbox` (`Chart.yaml` adı `kube-inspector-toolbox`; `helm push` yolu chart adından alıyor).
- Cluster içi adlar değişmedi: `_helpers.tpl` artık `.Chart.Name` değil sabit `toolbox` tabanını (`nameOverride`) kullanıyor; nesne adları ve `app.kubernetes.io/name=toolbox` etiketi aynı kaldı (render diff'i ile doğrulandı: yalnız `# Source` yorumları, image ve `helm.sh/chart` etiketi değişti). Desktop'un keşfi ve eski kurulumların yükseltmesi bu yüzden etkilenmiyor.

### Sonrası: kurulum kontrolü ve heartbeat düzeltmeleri (2026-10-30)
- Yeni kurulum kontrol edildi: 2 replika + ClickHouse sağlıklı, lease yenileniyor, webhook caBundle dolu; admission yeniden kurulumdan beri çalışıyor (eski kurulumda hiç istek gelmiyordu), 142 kayıt korunmuş, uygulamada "Canlı" akış ve gerçek kullanıcılar görünüyor.
- **Bulgu 1:** clickhouse-go `time.Time` parametresini saniye hassasiyetinde bağlıyor; heartbeat'ler `.000` ile yazılıyordu. Düzeltme: `fromUnixTimestamp64Milli`.
- **Bulgu 2:** yeniden kurulumdaki 44 sn'lik kesinti 45 sn eşiğinin altında kaldığı için boşluk sayılmadı, oysa yeni leader baştan listelediği için o arada olan değişiklikler kaçtı (her leader devrinde de böyle). Düzeltme: heartbeat'e leader dönemi (`term`, `0004_heartbeat_term.sql`) eklendi; term değişimi ne kadar kısa olursa olsun boşluk, eşik yalnız aynı term içindeki sessizlik için. Doküman, README, values ve CLAUDE.md düzeltildi. Test: `TestCoverageCountsEveryTermChange` (gerçek ClickHouse).

---

## Uygulama düzeni
- Plan modundan çıkınca ilk iş: bu dosyanın içeriği `toolbox/plan.md`'ye taşınır; ilerleme orada tutulur (her maddenin yanına durum: bekliyor / yapılıyor / bitti + doğrulama notu).
- Fazlar sırayla uygulanır. **Her faz sonunda durulur**: doğrulama çıktısı raporlanır, kullanıcı onayı olmadan sonraki faza geçilmez. Uygulama sırasında planda olmayan bir karar çıkarsa kullanıcıya sorulur.
- Commit yalnız kullanıcı isterse.
- Kod değişikliğinden sonra `graphify update .`.
- Yeni metinler 6 dilde (`frontend/src/locales/*/panels.json`).
- Goroutine'ler `safego.Go`; yeni oturum kayıtları (SSE) ownership-token kuralına uyar; panel params düz veri.

## Doğrulama
**Her fazda:**
- Operatör: `cd toolbox && make test`, `make test-store`, `make helm-lint`, gerekirse `make e2e` (kind + audit).
- Desktop: `GOEXPERIMENT=jsonv2 go test ./internal/services/ ./internal/business/ -run Toolbox`, `cd frontend && npm run build` (+ `npx vitest run` ilgili testler), `make dev` ile kind cluster'a kurulu toolbox'a karşı elle deneme.
- UI değişen fazlarda `scripts/ui/contrast_scan.py` 0 rapor etmeli (4 tema).

**Faz bazında kabul kontrolleri:**
- F1: path `/spec/replicas` filtresi yalnız scale değişikliklerini getirir; özel aralık `until` gönderir; pivot ikonu filtreyi doldurur ve detay açmaz; tab kapat/aç → filtreler durur, uygulama yeniden başlayınca sıfırlanır.
- F2: dört giriş noktasından obje paneli açılır; toolbox yokken girişler neden göstererek devre dışı; silinip yeniden yaratılmış objede ayırıcı görünür; namespace'i olmayan re-create dry-run'da reddedilir; rollback sonrası kendi kaydı ≤60 sn içinde vurgulanır.
- F3: leader pod'u silinince (`kubectl delete pod`) ≥45 sn'lik boşluk `/gaps`'te ve üç ekranda görünür; audit bağlı olmayan kind cluster'da "IP yok" uyarısı; eski operatör image'ında health 404 → güncelleme mesajı; CI workflow'u `act` ya da dry-run ile.
- F4: stats toplamları Changes listesiyle tutarlı; sütun/top-list tıklaması doğru filtreyi kurar; boşluk bandı grafikte.
- F5: export 50k sınırı ve CSV kaçışları (virgül/satır sonu içeren değerler) test edilir; attempts cursor'ı store testinde.
- F6: `-tags bench` 50M satırda list/q/stats/history < 2 sn.
- F7: `GET /` 404; TUI history + rollback; SSE'de yeni değişiklik ≤ enrich delay + birkaç sn içinde listede, bağlantı kesilince polling'e düşer, panel kapanınca stream oturumu temizlenir.
