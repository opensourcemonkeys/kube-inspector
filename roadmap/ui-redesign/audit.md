# Adım 0 — Temel çizgi ve denetim

Tarih: 2026-10-17. Plan: [`../ui-redesign.md`](../ui-redesign.md).

## Ekran görüntüleri

`before/<tema>/` altında, her temada aynı 39 ekran: 37 tanesi 1440×900, 2 tanesi 900×800. `focus-input` ve `focus-keyboard` Adım 1'de eklendi.

> **Yeniden çekim (Adım 1):** ilk çekimden sonra cluster'da metrics-server çalışmaya başladı; Overview, Monitoring, Nodes ve pod detayı artık veri gösteriyor. Önce/sonra aynı veriyle karşılaştırılsın diye `before/` seti eski kodla (`git worktree` + HEAD) yeniden çekildi. Eski kodu çalıştırırken iki tuzak var: worktree'deki Vite'a ayrı bir `cacheDir` verilmeli, yoksa iki Vite aynı `node_modules/.vite`'ı paylaşıp sayfaya iki React kopyası yükler; symlink'li `node_modules` için de `server.fs.strict: false` gerekir, yoksa fontlar yüklenmez ve görüntüler yanlış fontla çekilir. Dosya adları sabittir, yani Adım 12'de alınacak `after/` görüntüleriyle bire bir eşleşir.

Görüntüler `default 3` cluster'ında alındı: tek node'lu yerel k3s, 43 pod, metrics-server yok. Hata durumunu çekmek için TLS doğrulaması başarısız olan `cluster 1 …` kullanıldı.

| Grup | Ekranlar |
|---|---|
| Listeler | `overview`, `pods`, `deployments`, `services`, `configmaps`, `secrets`, `namespaces`, `events`, `networkpolicies`, `resourcequotas`, `crds`, `nodes`, `monitoring`, `securityrolemap`, `trivy` |
| Detay ve araç | `pod-detail`, `pod-yaml`, `pod-logs`, `terminal`, `yaml-editor`, `port-forwards`, `diagnostics` |
| Etkileşim | `list-selection`, `delete-dialog` (açılıp iptal edildi), `many-tabs`, `menu-open`, `cluster-dropdown`, `sidebar-collapsed` |
| Modallar | `ai-assistant`, `about-modal`, `update-modal`, `cluster-modal`, `tour-1`, `tour-2` |
| Durumlar | `cluster-error`, `focus-input`, `focus-keyboard` |
| Dar pencere | `narrow-900-pods`, `narrow-900-pod-detail` |

Yeniden çekmek için backend ve Vite çalışırken:

```bash
make electron-dev-go     # 1. terminal
make electron-dev-vite   # 2. terminal
python3 roadmap/ui-redesign/capture.py after
# tek ekran / tek tema:
ONLY=pods,pod-detail THEMES=monolith python3 roadmap/ui-redesign/capture.py after
```

Betik her senaryo için sayfayı yeniden yükler, böylece bir ekranda açık kalan dialog sonrakine sızmaz. Ulaşılamayan bir ekranı atlar ve sonda raporlar. Hiçbir şeyi silmez ya da değiştirmez: delete dialog açılıp iptal edilir.

> **Not (Adım 10):** tema kimliği `monolith` → `sodium` olarak değiştiğinde `THEMES` varsayılanı da güncellenmeli. `after/` için `THEMES=sodium,daylight,last-samurai,god-of-war` kullanılır.

## PrimeReact envanteri

`from 'primereact/…'` import sayıları, `.ts`/`.tsx` dosya başına. lara-dark-cyan bu bileşenlerin hepsinde renkleri sabit kodluyor. Açık temanın (Adım 10) her biri için token'a bağlı bir override'a ihtiyacı var. ✓ işareti, `theme-monolith.css`'te bugün bir override'ı olanları gösterir.

| Bileşen | Dosya | Override | Not |
|---|---:|:---:|---|
| button | 40 | ✓ | Adım 3: tuş primitifi |
| datatable + column | 36 | ✓ | Adım 5 |
| multiselect | 28 | ✓ | filtre satırı |
| tag | 26 | ✓ | Adım 3: çoğu `StatusLamp`'e geçer |
| toast | 19 | ✓ | |
| dialog | 13 | ✓ | `border-radius: 0 !important` |
| inputtext | 11 | ✓ | |
| dropdown | 10 | ✓ | |
| progressspinner | 8 | — | Adım 5/11: tek spinner; override yok, lara rengi |
| menu / menuitem / contextmenu / menubar | 3 / 6 / 1 / 1 | ✓ | title bar ve satır ⋮ menüsü |
| message | 3 | — | override yok, lara rengi |
| inputtextarea | 3 | ✓ | |
| checkbox | 3 | ✓ | |
| tabview | 2 | ✓ | Adım 3: Dockview tab dili |
| progressbar | 2 | ✓ | |
| overlaypanel | 2 | ✓ | |
| inputnumber | 2 | — | ScaleDialog; override yok |
| tooltip, splitter, speeddial, slider, colorpicker | 1'er | ✓ | |
| listbox | 1 | — | override yok |
| chart | 1 | — | chart.js; renkler bileşen içinde (Adım 2) |

Override'ı olmayan dört bileşen açık temada ilk bozulacak yerler: `message`, `inputnumber`, `listbox`, `progressspinner`.

✓ işaretlilerin çoğu da yalnız arka plan ve kenarlığı eziyor. lara'nın aksan ailesi (`#22d3ee` 92 kez, `rgba(34,211,238,…)` 141 kez) hover, focus ve `:active` durumlarında hâlâ altta duruyor.

En görünür örnek: **`.p-button:focus` için hiç override yok.** Bu yüzden lara'nın `0 0 0 .2rem rgba(34,211,238,.2)` camgöbeği halkası *her temada* her butonda çıkıyor. Monolith'te turkuaza yakın olduğu için göze batmıyor; God of War'da batıyor. Adım 3'teki `--focus-ring` bunu kapatır.

## MUI kullanımı

Kullanım beklenenden küçük. MUI yalnızca **`CircularProgress`** için, 4 dosyada kullanılıyor:

- `components/shared/PanelLoading.tsx`
- `components/networkpolicy/PolicyViewerPanel.tsx`
- `components/clusterresource/ClusterResourcePanel.tsx`
- `components/security/SecurityRoleMap.tsx`

Adım 11 bu yüzden tek bir ortak spinner bileşeni ile 4 import değişikliğinden ibaret. Ardından `@mui/material`, `@emotion/react` ve `@emotion/styled` silinir. `CLAUDE.md`'deki "PrimeReact + MUI" ifadeleri de o adımda düzeltilmeli.

## Fontlar

`main.tsx`, Inter 400/500/600/700 ve JetBrains Mono 400/500/600 yüklüyor. `@fontsource/geist` ve `@fontsource/outfit` `package.json`'da duruyor ama hiçbir yerde import edilmiyor.

## Sayısal başlangıç çizgisi

İlerleme bu sayılarla ölçülür. Hedef sütunu, kapının hangi adımda kapanacağını gösterir.

| Ölçüt | Adım 0 | Adım 1 sonrası | Adım 2 sonrası | Adım 3 sonrası | Adım 4 sonrası | Adım 5 sonrası | Adım 6 sonrası | Adım 7 sonrası | Adım 8 sonrası | Adım 9 sonrası | Adım 10 sonrası | Adım 11 sonrası | Adım 12 sonrası (son) | Hedef |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:| ---: | ---: | ---: | ---: |---|
| `rgba(63,200,180,…)` turkuaz kopyası | 28 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | aynı | aynı | aynı | aynı | 0 (Adım 1) |
| Diğer durum rgba kopyaları (`224,125,110` / `226,168,90` / `95,201,138`) | 27 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | aynı | aynı | aynı | aynı | 0 (Adım 1) |
| lara değişkeni (`--surface-*`, `--text-color*`, `--primary-color`, `--yellow`); 11 dosya | 42 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | aynı | aynı | aynı | aynı | 0 (Adım 1) |
| Tanımsız `var(--font-mono)` / `var(--line3)` (+ `--text` / `--text-muted`, sonradan bulundu) | 8 / 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | aynı | aynı | aynı | aynı | 0 (Adım 1) |
| `.ts`/`.tsx` içinde tırnaklı hex literal | 36 | 34, hepsi izinli dosyalarda (`clusterColors.ts`, `themeColors.ts` fallback, bir test) | 42, hepsi izinli dosyalarda (+ `monacoTheme.ts` şeffaf kenarlık) | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | yalnız `clusterColors.ts` ve `PALETTE_FALLBACK` (Adım 11) |
| `style={{` | 685 | 685 | 685 | 685 | 676 | 647 | 610 | 397 | 369 | 369 | 369 | 300 (renk/yazı 0; kalanı kolon genişliği ve veriden konum) | 300 (renk/yazı 0) | ≤ 250 (Adım 4–7; düzen için kalabilir, renk için kalamaz) |
| `text-transform: uppercase` (css) / `textTransform: 'uppercase'` (tsx) | 19 / 9 | 19 / 9 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | aynı | aynı | aynı | aynı | 0 (Adım 2) |
| `infinite` animasyon | 5 | 5 | 5 | 5 (spinner tek renk) | 5: spinner (2) + 3 döngü (Adım 9); `warn-pulse` kalktı | aynı | aynı | 5: spinner (3, `.spinner` dahil) + `ai-bounce`, `ai-tool` (Adım 8/9); Trivy imleci kalktı | yalnız spinner (3 kural; biri kullanılmayan `ProgressSpinner` override'ı, Adım 11) | yalnız spinner (3 kural); azaltılmış harekette yavaşlar ama durmaz | aynı | yalnız spinner (2 kural + reduced-motion istisnası); `ProgressSpinner` override'ı silindi | aynı | yalnız spinner (Adım 9) |
| Farklı `border-radius` değeri | 20+ (`0`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `10`, `11`, `14`, `16`, `20px`, `50%`, `999px`…) | 24 (token'lar tanımlandı, henüz uygulanmadı) | 24 | 3 token + `0`, `50%`, `1px` + 2 balon (Adım 8) | aynı | aynı | aynı | aynı | 3 token + `0`, `50%`, `1px` (AI balonları kalktı) | aynı | aynı | aynı | 3 token + `0`, `50%`, `1px`; 3 yerde `2px` (3px kap içindeki iç tuş, iç içe yarıçap) | 3 token + `50%` lamba (Adım 1/3) |
| `outline: none/0` | 19 | 19 (focus artık `box-shadow` ile, bkz. Focus bloğu) | 19 | 19 (genel `:focus-visible` kuralı hepsini kapsıyor) | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | 19, hepsi `:focus-visible` halkasıyla eşli; klavye taramasında halkasız durak 0 | yalnız `:focus-visible` ile eşleşmiş olanlar (Adım 3) |
| Yükleme göstergesi türü | 3 (ProgressSpinner 8 dosya, CircularProgress 4, PanelSkeleton 2) | 3 | 3 | 3 | 3 | ProgressSpinner 5 dosya (listeler iskelete geçti; kalanlar node, pod detayı, describe, changelog, port-forward) | ProgressSpinner 4 dosya | `Spinner` + iskelet; ProgressSpinner 2 dosya (PortForwardDialog, ChangelogNotes — Adım 8); MUI paketten silindi | `Spinner` + iskelet; ProgressSpinner 0 | aynı | aynı | `Spinner` + iskelet | aynı | 1 + iskelet (Adım 5/11) |
| Emoji / glif içeren metin | `tourSteps.ts` (7), `PolicyViewerPanel` `✕ blocked` (2), `AiChat` `⚠️`, `TrivyScanner` `✓` (2) | aynı | aynı | aynı | aynı | aynı | aynı | `tourSteps.ts` (7), `AiChat` `⚠️` (Adım 8) | 0 | aynı | aynı | aynı | aynı | 0 (Adım 7/8) |
| `font-weight: 700` / `bold` (css / tsx) | — | — | 0 / 0 (Plex yalnız 400/500/600 yükleniyor) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | aynı | aynı | aynı | aynı | 0 |
| Global `scroll-behavior: smooth` | 1 (`*`) | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | aynı | aynı | aynı | 0 (Adım 9) |
| `prefers-reduced-motion` desteği | yok | yok | yok | yok | yok | yok | yok | yok | yok | CSS bloğu + xterm/Monaco imleci | aynı | aynı | aynı | var (Adım 9) |
| Tema | monolith + 2 | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | sodium, daylight, last-samurai, god-of-war (Ek: `sodium` → `graphite`, aksan logo mavisi `#58bde8`) | aynı | aynı | + açık tema (Adım 10) |
| Sabit siyah gölge/inset (`rgba(0,0,0,…)`) | — | — | — | — | — | — | — | — | — | — | 0 (token: `--recess`, `--press`, `--key-lift`, `--accent-lift`, `--screen-shade`) | aynı | aynı | 0 (Adım 10) |
| Build'deki kullanılmayan font (lara Inter) | ~0.7 MB | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | aynı | 0 | aynı | 0 (Adım 11) |
| AA altı metin (contrast_scan, 4 tema × 26 ekran) | ölçülmedi | — | — | — | — | — | — | — | — | — | — | — | 0 (ilk tarama 38 çift) | 0 (Adım 12) |
| Halkasız klavye durağı (Pods, 70 Tab) | ölçülmedi | — | — | — | — | — | — | — | — | — | — | — | 0 (2 gerçek eksik düzeltildi) | 0 (Adım 12) |

Sayıların nasıl üretildiği (grep kapıları) `ui-redesign.md` dosyasının "Doğrulama" bölümünde.

## Görüntülerden çıkan yeni bulgular

Bunlar plan yazılırken koddan görülmemişti. Her biri hedef adımına not olarak eklendi.

1. **İki Overview sekmesi ve sahipsiz "•" (Adım 4).** `DockviewContainer.onReady` (`components/workspace/DockviewContainer.tsx:153`), ClusterContext cluster listesini yüklemeden çalışıyor. İlk sekme bu yüzden `clusterName: ""` ile açılıyor: id `overview:`, başlık "Overview", içerikte `• ` (`overview/main.tsx:90`). Sidebar'dan Overview'a tıklanınca ikinci bir `Overview • default 3` sekmesi açılıyor (`overview.png`, `ai-assistant.png`). Açılış sekmesi `activeCluster` gelene kadar beklemeli, boş isimde ayırıcı da hiç yazılmamalı.
2. **Sidebar senkron hatasının kanıtı (Adım 4).** Uygulama Overview sekmesiyle açılıyor ama sidebar'da *Pods* işaretli görünüyor (`overview.png`).
3. **Grup adları çeviri dosyalarında büyük harf (Adım 2).** `locales/*/nav.json` → `group.*`: "WORKLOADS", "CONFIG & SECRETS", "KONFIGURATION & SECRETS", "İŞ YÜKLERİ"… CSS'teki uppercase kuralını kaldırmak yetmez; 6 dilin `nav.json`'u sentence case'e çevrilmeli ("Workloads", "Config & secrets"). `i18n:check` yalnız anahtarları denetlediği için bunu yakalamaz.
4. **Kapalı sidebar grubunda `aria-expanded` yok (Adım 4).** Değer `expanded[key]`'den geliyor ve hiç açılmamış grupta `undefined`. Yani ekran okuyucu kapalı grubu "genişletilebilir" diye bildirmiyor. `aria-expanded={!!expanded[group.key]}` olmalı. e2e `expand_sidebar_group` bugün yalnız `!= "true"` diye baktığı için çalışıyor.
5. **Satır eylem butonlarının erişilebilir adı yok (Adım 5).** Pod satırındaki Logs ve Exec butonlarında `title` de `aria-label` da yok; yalnız ⋮ butonunda "More actions" var. `p-button-icon-only` sınıfını da taşımıyorlar, bu yüzden CLAUDE.md'deki `gap` tuzağına açıklar. `actionColumn.ts` üzerinden hepsi birden düzeltilir: `aria-label`, tooltip ve `icon`-only işaretlemesi.
6. **Her hücre bir pill (Adım 5).** Pods listesinde Status, Ready ve Owner kolonlarının üçü de renkli `p-tag` (`pods.png`). 43 satırın hepsinde turkuaz "Deployment" pill'i tekrar ediyor. Owner düz metne, Ready tabular sayıya, Status `StatusLamp`'e geçmeli. Tag yalnız gerçekten etiket olan bilgiye kalmalı.
7. **Sıralama ikonları başlık metninden büyük (Adım 5).** 11px'lik uppercase başlığın yanında yaklaşık 18px'lik ↑↓ ikonu duruyor ve her kolonda sürekli görünüyor. İkon küçülmeli; sıralanmamış kolonda yalnız hover'da görünmeli.
8. **Hep görünen pasif "Delete Selected" (Adım 5).** Seçim yokken de kırmızı konturlu, devre dışı bir buton olarak duruyor. Seçim yokken gizlenmeli ya da sessiz kalmalı; seçim olunca "3 öğeyi sil" olarak belirmeli.
9. **Hata durumunda boş tablo (Adım 5).** `cluster-error.png`: hata bandının altında filtre satırı ve boş bir satır kalıyor, hiçbir açıklama yok. Bant kırmızı zemin üstünde kırmızı yazı ve uzun hata tek satırda kesiliyor. Hata durumu tabloyu değiştirmeli: ne oldu, hangi cluster, Retry ve Copy diagnostics eylemleri, ayrıntı açılır bölümde.
10. **metrics-server bandı çok yüksek sesli (Adım 6).** Overview ve Monitoring'de tam genişlik, doygun sarı zemin ve 15px yazı (`overview.png`, `monitoring.png`). Bu bir hata değil, bir bilgi. Kapasite göstergesinin yerinde sakin bir "veri yok" durumu olmalı, kurulum ipucu da ikincil satırda. Pod detay grafiğindeki kesik çizgili boş kutu da aynı dile geçmeli.
11. **Node bellek kapasitesi ham (Adım 6).** `nodes.png`: "MEM Cap: 32326340Ki". `node.memory_capacity` doğrudan basılıyor; `mem_capacity_mi` zaten var, yani "30.8 GiB" olarak gösterilmeli. "MEM Cap" / "CPU Cap" etiketleri de kısaltma; "Memory" / "CPU" yeter.
12. **Node kartında renkli eylem metinleri (Adım 6).** Cordon turuncu, Drain kırmızı, terminal ikonu mavi, sonuncusu gri. Dört eylem dört farklı renk. Tuş stiline geçmeli; yalnız Drain tehlikeli eylem rengini almalı.
13. **Dar pencerede pod detayı kırılıyor (Adım 7).** `narrow-900-pod-detail.png`: 900px'te sidebar 240px'te sabit kalıyor, liste yalnız Name kolonuna düşüyor. Detay panelinin etiket/değer ızgarası kelimeleri harf harf bölüyor ("Re pl ic aS et"). Panel ~420px altına inince etiket üstte, değer altta düzenine geçmeli. Kimlik değerleri `overflow-wrap: anywhere` ile değil, mono ve kesmeli (ellipsis + kopyala) gösterilmeli.
14. **Modal maskesi neredeyse opak siyah (Adım 3).** `cluster-modal.png`, `about-modal.png`: arkadaki uygulama neredeyse kayboluyor. Maske ~%55 `--screen` tonuna inmeli; böylece "nerede olduğumu" bilgisi kaybolmaz.
15. **Log toolbar'ı (Adım 7).** Etiketsiz 5 ikon toggle var ve aktif olanlar turkuaz dolgulu. Arama yokken de "0 matches" yazısı duruyor. Toggle'lar etiketli bir segmentli gruba toplanmalı, sayaç yalnız arama varken görünmeli.
16. **AI penceresi gölgesiz yüzüyor (Adım 8).** Altındaki node kartıyla aynı zemin rengini kullanıyor ve sınırı yalnız 1px çizgi; içerikten ayrışmıyor. Yüzen pencere `--shadow-3` ve `--bezel` almalı.

## Planda değişiklik gerekmeyen doğrulamalar

- Alternatif temalarda camgöbeği/turkuaz sızıntısı gerçekten var: `before/god-of-war/cluster-modal.png`'de focus'lu input'un kenarlığı turkuaz, oysa temanın aksanı turuncu. *Düzeltme (Adım 1):* bu kenarlık bizim `rgba(63,200,180,…)` kopyalarımızdan değil, lara'nın `.p-inputtext:enabled:focus` kuralından geliyordu; bizim override'ımız özgüllükte yeniliyordu. Seçili checkbox'lar doğru renkteydi, çünkü `var(--teal)` kullanıyorlardı.
- Tab'ın üst şeridi cluster rengini doğru taşıyor. `--tab-accent` deseni korunacak.
- Monaco ve terminal zeminleri bugün de uygulamadan koyu. Bu `--screen-dark` fikrini destekliyor; mevcut hâli sabit kodlu `#080b11`.
