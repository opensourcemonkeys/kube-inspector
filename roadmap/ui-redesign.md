# Arayüz Yeniden Tasarım Planı — "Kontrol Odası"

## Context

Kube Inspector'ın arayüzü bugün çalışıyor, ama bakan birine "bunu AI yapmış" dedirten kalıpların neredeyse hepsini taşıyor:

- **Neredeyse siyah zemin + tek parlak turkuaz aksan** (`--app: #080b11`, `--teal: #3fc8b4`).
- **Inter** fontu (yanında kullanılmayan Geist/Outfit paketleri de var).
- **Her yerde harf aralıklı BÜYÜK HARF etiketler**: tablo başlıkları, sidebar grup rozetleri, modal etiketleri, bölüm başlıkları, `tb-title: KUBE INSPECTOR`.
- **Birbirinin aynısı yuvarlak kartlar**: Overview kutucukları, monitoring kartları, node kartları; büyük sayı + küçük etiket kalıbı.
- **Gradyan dolgular**: aktif sidebar öğesi, aktif tab, monitoring switch'i.
- **Sohbet balonlu AI penceresi**, logo kutulu ve pill sürümlü About/Update modalları, emoji ikonlu tur.
- **Sürekli dönen animasyonlar**: `warn-pulse`, `ai-bounce`, `trivy-blink`.

Bunlara ek olarak **gerçek tutarsızlıklar ve hatalar** var:

- ~40 yerde turkuaz `rgba(63,200,180,…)` elle kopyalanmış. God of War / Last Samurai temalarında aksan değişiyor ama focus ring'ler, hover'lar, update butonu turkuaz kalıyor.
- Tanımsız değişkenler kullanılıyor: `--font-mono`, `--line3`. Bunlara ek olarak sabit hex'ler var: `#e06c6c`, `#252e3f`, `#62e3cf`, Monaco zemini `#080b11 !important`.
- lara temasından kalan değişkenler 11 dosyada kullanılıyor (`--surface-border`, `--text-color-secondary`, `--yellow`, `--primary-color`). Bunlar palet değişince takip etmiyor.
- Üç farklı yükleme göstergesi var: MUI `CircularProgress`, PrimeReact `ProgressSpinner`, `PanelSkeleton`.
- Radius hiyerarşisi yok: dialog'lar `0 !important`, menüler `11px`, kartlar `8px`, butonlar `6px`.
- Tablolarda `stripedRows` ile `showGridlines` birlikte açık; sonuç çok ağır bir görünüm.
- Sidebar'ın aktif öğesi Dockview'deki aktif tab'ı takip etmiyor (`menu.tsx` içinde lokal `activeView` state'i).
- Aynı ikon birden fazla menüde kullanılıyor: `VscCopy` ×2, `VscTypeHierarchySub` ×3, `VscSettings` ×2, `VscShield` ×2.
- i18n'e girmemiş metinler var: Overview'de `"Nodes"` ve `` `Open ${t.title}` ``, Policy viewer'da `"✕ blocked"`, AI'da `⚠️`.
- `SecurityRoleMap` (59), `PolicyViewerPanel` (45), `pod/main` (41), `node/main` (41) gibi dosyalarda inline style yoğun. Bu stiller temayı takip etmiyor.

**Hedef:** Kubernetes'in kendi dünyasından gelen, kendine has bir kimlik. Bir operasyon aracı olduğu için **kontrol odası / endüstriyel enstrüman paneli** dili seçildi: sakin, yoğun, ciddi, ustaca işlenmiş. Yeni kimlik varsayılan tema olacak. Aynı token sistemiyle gerçek bir açık tema eklenecek, Last Samurai ve God of War korunup yeni sisteme taşınacak.

**Alınan kararlar:** Kontrol odası yönü · IBM Plex Sans + Plex Mono · yeni varsayılan tema + açık tema · hareket sakin ve sadece tepkisel.


---

## Tasarım Dili

### Ana fikir: "Çerçeve ve Ekran"

Gerçek bir kontrol panelinde metal **çerçeve** (bezel) açık ve mat olur. Göstergeler, yani **ekranlar**, ondan koyu ve gömülü durur. Uygulamada:

- **Çerçeve:** title bar, sidebar, tab şeridi, toolbar'lar.
- **Ekran:** tablo, YAML, log ve terminal içerikleri.

Bugün ikisi de aynı siyah. Yeni sistemde ekran bir ton daha koyu olacak ve üst kenarında 1px'lik bir iç gölgeyle "gömülü" duracak. **Tüm cesaretin harcandığı tek yer burası.** Geri kalan her şey sessiz ve disiplinli olacak.

```
┌─ title bar (çerçeve, mat grafit) ─────────────────────────────┐
├──────────┬─ tab şeridi (çerçeve) ─────────────────────────────┤
│ sidebar  │┌─ ekran (koyu, gömülü, üstte iç gölge) ───────────┐│
│ (çerçeve)││ toolbar: Pods   142 pod        [filtre] [sil]    ││
│          ││ ───────────────────────────────────────────────  ││
│ ▌Pods    ││ ● nginx-7d…   default   Running   2m             ││
│  Deploy… ││ ▲ api-5f…     prod      Pending   14s            ││
│          │└──────────────────────────────────────────────────┘│
└──────────┴────────────────────────────────────────────────────┘
```

### Renk token'ları (varsayılan koyu tema, "Sodyum")

Sıcak kırık beyaz yazı, soğuk grafit zemin. Saf siyah ya da "#0B0B0B tarzı" renklendirilmiş siyah kullanılmayacak.

| Token | Hex | Kullanım |
|---|---|---|
| `--screen` | `#17191b` | İçerik ekranı (eski `--app`) |
| `--screen-2` | `#1e2124` | Ekran içinde hover ve yükseltilmiş satır |
| `--bezel` | `#24282c` | Title bar, sidebar, tab şeridi, toolbar (eski `--panel`) |
| `--bezel-raised` | `#2d3237` | Tuş/buton yüzeyi, popover |
| `--line` / `--line-strong` | `#2c3034` / `#3a4045` | Ayırıcılar |
| `--ink` / `--ink-2` / `--ink-3` | `#ece6d9` / `#a8a397` / `#75726a` | Yazı. `--ink-3` yalnız ikincil bilgide kullanılır, gövde metninde değil. |
| `--accent` | `#eea13c` | Sodyum lambası. Seçim, focus, birincil buton ve aktif tab'da kullanılır, **başka hiçbir yerde değil**. |
| `--on-accent` | `#1a1205` | Aksan üstündeki yazı |
| `--ok` / `--warn` / `--err` / `--info` | `#7fb685` / `#e3c84b` / `#e5604f` / `#7aa7c7` | Sadece durum sinyalleri |
| `--screen-dark` | `#121416` | Monaco, log ve terminal. **Açık temada da koyu kalır**, çünkü gerçek enstrüman ekranları gün ışığında da koyudur. |

Aksan (turuncu-sarı) ile `--warn` (sarı) birbirine yakın. Bu yüzden durum asla yalnız renkle verilmeyecek, her zaman **lamba şekli + metin** ile verilecek: ● çalışıyor, ▲ uyarı, ■ hata, ○ beklemede. Bu, renk körlüğü için de doğru çözüm.

**Açık tema, "Gün ışığı":** alüminyum çerçeve `#e3e6e8`, ekran `#f7f8f8`, yazı `#1f2326`, aksan `#a65c0a` (beyaz üstünde AA). Krem/bej tonlar özellikle kaçınılıyor, çünkü onlar da bir AI kalıbı. Kod, log ve terminal ekranları koyu kalıyor (`--screen-dark`).

**Yapısal token'lar:**
- Radius hiyerarşisi: kontrol `3px`, popover/menü `6px`, dialog/yüzen pencere `8px`. Rozet ve pill yok.
- Gölge: `--shadow-1..3`, temaya göre ayarlı.
- Focus: `--focus-ring: 0 0 0 2px var(--accent)`.
- Boşluk ölçeği: 4px.
- Yoğunluk: `--row-h` ve `--ctl-h`.

### Tipografi

- **IBM Plex Sans** (400/500/600) arayüzün tamamında. **IBM Plex Mono** (400/500) yalnızca **kopyalanan tanımlayıcılarda**: image ref, IP, port, UID, hash, YAML, log, terminal. Kaynak adları Sans ile yazılır. Mono, "küçük veri etiketi" süsü olarak kullanılmaz.
- Ölçek (masaüstü, yoğun): `11 / 12 / 13 (temel) / 15 / 18 / 24`. Ağırlıklar 400 ve 500 ağırlıklı kullanılır; 600 yalnız başlıklarda, 700 hiç yok.
- **Büyük harf etiket yok.** Tablo başlıkları, grup adları ve bölüm başlıkları sentence case, 500 ağırlık, `--ink-2` renginde olacak.
- Sayısal her yerde `font-variant-numeric: tabular-nums` (Plex'te var).
- Meta metinleri " · " ile birleştirmek ve "Kelime — parça" etiket kalıbı kullanılmayacak.

### Hareket ilkeleri

- `infinite` döngü yok. Tek istisna: gerçekten süren bir işlemin spinner'ı.
- Hareket yalnızca **kullanıcı eylemine yanıt** olur: panel ve menü açılması (120–160ms), satır seçimi, yeni gelen verinin bir kerelik vurgusu (değişen hücre 600ms'de söner).
- **Tek imza anı:** uygulama açılışında ekranların bir kez "açılması". Çerçeveden ekrana 400ms'lik parlaklık geçişi.
- Her şey `prefers-reduced-motion` ile kapatılabilir.

---

## Adımlar

Her adım tek başına birleştirilebilir (merge edilebilir) ve uygulamayı çalışır bırakır. Sıralama bağımlılığa göredir: token → tipografi → bileşen primitifleri → ekranlar → tema ve temizlik.

### Adım 0 — Temel çizgi (baseline) ve denetim ✅
> **Tamamlandı (2026-10-17).** Sonuçlar [`ui-redesign/audit.md`](ui-redesign/audit.md) dosyasında. Ekran görüntüleri `ui-redesign/before/<tema>/` altında (her temada 37 ekran). Bunları üreten betik `ui-redesign/capture.py`; Adım 12'de `after` argümanıyla tekrar çalıştırılır. Denetimde çıkan 16 yeni bulgu aşağıdaki adımlara "(denetim #N)" notuyla işlendi.

- `make dev` (Electron) ya da `--serve` + Chromium ile **her ekranın mevcut halinin ekran görüntüsünü** al: liste, overview, monitoring, nodes, pod detail, YAML, log, terminal, AI, modallar, tur. Her biri 3 temada. Görüntüler `roadmap/ui-redesign/before/` altına konur.
- Kullanılan PrimeReact bileşenlerinin envanteri: `grep "from 'primereact/"`. Açık tema her birinin token'a bağlanmış bir override'ını gerektirecek, çünkü lara-dark-cyan renkleri sabit kodluyor.
- MUI'nin kullanıldığı 4 dosyada ne için kullanıldığı not edilir (adım 11'de kaldırılacak).

### Adım 1 — Token temeli (görünür kimlik değişmeden önce altyapı) ✅
> **Tamamlandı (2026-10-17).** Planlanandan farklı olanlar:
> - **Takma ad yerine tam yeniden adlandırma.** Değerler bu adımda değişmediği için eski adlar (`--app`, `--teal`, `--ink2`…) 45 dosyada mekanik olarak yeni adlara çevrildi; takma ad katmanı tutulmadı. Böylece sonraki adımlarda bir rengin iki adı olmayacak. Eşleme: `--app`→`--screen`, `--hover`→`--screen-2`, `--panel`→`--bezel`, `--panel2`→`--bezel-raised`, `--panel3`→**`--bezel-high`** (planda yoktu; tooltip, toast ve başlık bandı katmanı), `--line2`→`--line-strong`, `--ink2/3`→`--ink-2/3`, `--teal`→`--accent`, `--green/amber/red/blue`→`--ok/warn/err/info`. `--violet` kategori rengi olarak kaldı.
> - **lara sızıntısı sanılandan büyükmüş.** Yalnız `.p-button:focus` değil: bizim `.p-inputtext:focus` ve `.p-dropdown.p-focus` kurallarımız lara'nın `:enabled` / `:not(.p-disabled)` taşıyan seçicilerine özgüllükte yeniliyordu. Yani focus'lu her input ve dropdown her temada `#22d3ee`'ydi. Ayrıca "sessiz varsayılan buton" kuralı `:not([class*="p-button-"])` yüzünden `-sm` / icon-only butonları dışarıda bırakıyordu; "New Namespace", "Apply" gibi dolgulu butonlar ve renksiz text butonlar ("Cancel") lara camgöbeğiydi. Hepsi lara'nın kendi seçicileriyle token'a bağlandı. Kural CLAUDE.md'ye yazıldı.
> - **`InstancePickerMenu.css`** tanımsız `--text` / `--text-muted`'a ve sabit kodlu mavimsi bir palete dayanıyordu; token'lara bağlandı.
> - Doğrulama: monolith'te 37 ekranın tamamı, yeni veriyle yeniden çekilen `before/` ile piksel düzeyinde karşılaştırıldı (bkz. denetim raporu). God of War ve Last Samurai'de focus ve buton renkleri temanın aksanına geçti. Klavye focus halkası hesaplanmış stilden okunarak doğrulandı.

**Dosyalar:** `frontend/src/theme-monolith.css` (`:root` ve tema blokları), `frontend/src/lib/themeColors.ts` (`ThemeVar` + `PALETTE_FALLBACK`)
- Yeni anlamsal token'lar eklenir: `--screen`, `--bezel`, `--accent`, `--ok`… Eski adlar **takma ad olarak korunur** (`--teal: var(--accent)`, `--app: var(--screen)`…). Böylece ~50 bileşen kırılmadan geçiş yapılır. Custom property'nin hesaplanmış değerinde `var()` çözüldüğü için `themeColor()` ve `themeAlpha()` hex almaya devam eder.
- CSS'teki tüm `rgba(63,200,180,…)`, `rgba(224,125,110,…)`, `rgba(226,168,90,…)`, `rgba(95,201,138,…)` kopyaları `color-mix(in srgb, var(--accent) N%, transparent)` biçimine çevrilir. Bu, alternatif temalardaki turkuaz sızıntısını düzeltir.
- Tanımsız değişkenler düzeltilir: `--font-mono` → `--font-family-mono`, `--line3` → `--line-strong`. Sabit hex'ler token'a çevrilir: `#e06c6c`, `#252e3f`, `#62e3cf` ve Monaco'nun `#080b11` değeri `--screen-dark` olur.
- `.tsx` dosyalarındaki lara değişkenleri (`--surface-border`, `--text-color-secondary`, `--yellow`, `--primary-color`, `--surface-ground`; 11 dosya) bizim token'larımıza çevrilir.
- Radius, gölge, focus, boşluk ve yoğunluk token'ları tanımlanır.
- lara'nın aksan ailesi (`#22d3ee`, `rgba(34,211,238,…)`) override'ı olmayan durumlarda sızıyor. En belirgini `.p-button:focus`: hiç override'ı yok, bu yüzden her temada camgöbeği focus halkası çıkıyor. Bu adımda en azından `.p-button:focus` / `.p-checkbox` / `.p-radiobutton` focus'u `--focus-ring`'e bağlanır. (denetim: PrimeReact envanteri)
- **Bitti sayılır:** `grep -rn "63,200,180\|--surface-\|--text-color" frontend/src` boş döner ve God of War temasında hiçbir yerde turkuaz kalmaz.

### Adım 2 — Yeni palet ve tipografi ✅
> **Tamamlandı (2026-10-17).** Planlanandan farklı ya da fazla olanlar:
> - **Kontrast ayarı:** `--ink-3` planlanan `#75726a` değeriyle input zemininde 2.69:1'de kalıyordu (placeholder'lar okunmuyordu). `--ink-2` `#b8b3a7`, `--ink-3` `#8f8b83`, `--err` `#e9786a` oldu. Üç yazı tonu arasında eşit adım var (1.68 / 1.62). `--ink-3` `--screen`'de 5.19:1, bezel'de 4.37:1; yalnız üçüncül metinde kalmalı (Adım 12'de denetlenecek). Yeni katman `--bezel-high` `#353a40`.
> - **`--ansi-*` token'ları:** xterm ve Monaco sözdizimi için. Kırmızı/yeşil/sarı/mavi durum renklerine bağlı; cyan ayrı bir ton (`#6fb3b8`), böylece aksan turuncuya dönünce terminaldeki cyan çıktı turuncu olmadı.
> - **Monaco:** `vs-dark` yerine paletten okunan `kube-ins` teması (`lib/monacoTheme.ts`); tema değişince yeniden tanımlanıyor. Editör ayarları `MONACO_BASE_OPTIONS`'ta tek yerde. `!important`'lı arka plan hileleri silindi. Log görüntüleyici kendi `"Monaco", monospace` yığınını kullanıyordu, o da Plex Mono'ya ve `--screen-dark`'a alındı.
> - **Font yükleme:** xterm ve Monaco hücre genişliğini açılıştaki fonttan ölçüyor. `lib/fonts.ts` Plex Mono'yu uygulama açılırken yüklüyor, Monaco font gelince yeniden ölçüyor.
> - **Kalın yazı:** Plex yalnız 400/500/600 yüklendiği için 700 isteyen her kural sentetik kalın çiziliyordu (lara'da ~40 yer, `<b>`/`<strong>`). Hepsi 600'e bağlandı. lara'nın `.p-button-label { font-weight: 700 }` kuralı yüzünden `.p-button`'daki 500 hiçbir butonun yazısına ulaşmıyordu; etiket artık butonun ağırlığını miras alıyor.
> - **Aksanın anlam değişikliği:** eski palette tek turkuaz hem aksan hem "bilgi" rengiydi. `.p-tag-info` (pod listesindeki her Owner hücresi) ve linkler bu yüzden turuncuya dönüyordu; `--info`'ya bağlandılar.
> - **e2e:** grup adları sentence case olunca seçiciler güncellendi. Bu sırada var olan bir hata bulundu ve düzeltildi: testler uygulamada olmayan `"CONFIG & SECURITY"` grubuna başvuruyordu.
> - **Adım 11'den öne alınanlar:** `@fontsource/inter`, `jetbrains-mono`, `geist`, `outfit` ve kullanılmayan `assets/fonts/nunito-*` kaldırıldı.
> - Kalanlar planlanan adımlarında: title bar'daki `KUBE INSPECTOR` (Adım 4), Monitoring'in turuncu gradyanlı anahtarı (Adım 6), Nodes eylem renkleri (Adım 6), pod detayındaki turuncu "Pod:" etiketi (Adım 7).

**Dosyalar:** `theme-monolith.css`, `frontend/src/main.tsx` (font importları), `frontend/package.json`, `lib/clusterColors.ts`, `lib/monacoTheme.ts`, `lib/xtermTheme.ts`
- `:root` bloğu Sodyum paletine geçer. `@fontsource/ibm-plex-sans` ve `@fontsource/ibm-plex-mono` eklenir. `--font-family` ve `--font-family-mono` güncellenir.
- Chart.js için tek bir yerde `Chart.defaults.font.family` ve renk varsayılanları ayarlanır. Şu an `UsageChart.tsx` gibi her grafik `family`'yi kendisi veriyor.
- Monaco ve xterm temaları paletten türetilir (`themeColor`), font Plex Mono olur, ligature kapalı kalır. **Dikkat:** `xtermTheme.ts`'te ANSI cyan ve brightCyan bugün `--accent`'ten geliyor; aksan turuncuya döndüğünde terminaldeki cyan çıktı turuncu olur. ANSI renkleri durum token'larına değil, kendi küçük ANSI paletine bağlanmalı. Monaco hâlâ `vs-dark` ve sözdizimi renkleri (turkuaz type/key) temadan bağımsız; Last Samurai'de de turkuaz görünüyor.
- Cluster renk paleti (`clusterColors.ts`) grafitle uyumlu olacak ama birbirinden ayırt edilebilecek şekilde yeniden ayarlanır. Gerekirse mevcut kayıtlı renkler için migration yazılır.
- Global tipografi: büyük harf ve letter-spacing kuralları kaldırılır. **Bu yetmez:** sidebar grup adları 6 dilin `locales/*/nav.json` → `group.*` değerlerinde zaten büyük harfle yazılmış ("WORKLOADS", "İŞ YÜKLERİ"). Bunlar sentence case'e çevrilir. (denetim #3) Bunlar şu sınıflarda: `p-datatable th`, `sidebar-section__badge-label`, `cluster-modal__label`, `mon-section-title`, `pd-table th`, `update-notes__*`, `diag-*`, `about-modal__section-title`, `exec-container-menu .p-submenu-header`, `cluster-modal__stat span`, `ai-tool__badge`.

### Adım 3 — Bileşen primitifleri (PrimeReact override'ları) ✅
> **Tamamlandı (2026-10-17).** Planlanandan farklı ya da fazla olanlar:
> - **Buton rolü prop'lardan gelir.** Severity'si olmayan 18 düz butonun hepsi birincil eylem (Save, Apply, Create, Start, Scan), bu yüzden düz buton = aksan dolgulu birincil tuş. Adım 1'deki "sessiz varsayılan" kuralı kaldırıldı. `secondary`/`outlined` nötr tuş, `danger`/`warning` hover'da dolan kontur, `text`/`link` sessiz (aksan değil `--ink-2`; link `--info`). Kontrol yüksekliği `--ctl-h` (28px), küçük 24px. lara'nın 5 sınıflık severity+text hover kuralı yüzünden 38 text butonun hover zemini görünmüyordu; aynı ağırlıkta kural eklendi.
> - **StatusLamp bu adımda durum kolonlarına uygulandı:** 11 listenin Status kolonu, Events tipi, node durumu ve port-forward durumu. Events'te "Normal" artık yeşil değil, boşta halkası (○). Ready sayaçları, Owner, Service tipi ve Trivy önem dereceleri planlandığı gibi Adım 5 ve 7'de.
> - **Genel klavye focus kuralı:** 19 `outline: none` kuralı tek tek düzeltilmedi. Uygulamanın kendi kontrolleri (sidebar, title bar, modal butonları, popover satırları) için tek bir `:focus-visible` kuralı yazıldı. PrimeReact bileşenlerini dışarıda bırakıyor (onlar Focus bloğunda), tek sınıflı `outline: none`'ı da yeniyor. Tarayıcıda doğrulandı: klavyede halka var, fare tıklamasında yok.
> - **Köşe yuvarlaklıkları:** 91 sabit değer, seçicinin anlamına göre (kontrol / popover / pencere) token'lara çevrildi. Kalan yalnız `0`, `50%`, lamba işaretindeki `1px` ve Adım 8'de kalkacak AI sohbet balonları.
> - **Bulunan başka sızıntılar:** lara'da `p-tag-contrast` tanımlı değil (Owner'ı olmayan pod'un etiketi camgöbeğiydi). PrimeReact spinner'ı kırmızı-mavi-yeşil-sarı arasında renk değiştiriyordu; tek renge sabitlendi. Cluster modal kendi `rgba(0,0,0,.65)` maskesini ve `backdrop-filter: blur` kullanıyordu; `--maskbg`'ye bağlandı, bulanıklık kaldırıldı.
> - `Message` (metrics-server bandı dahil) lara'nın 6px renkli şeridi yerine bezel zemin + ince kontur + renkli ikon aldı. Bandın konumu ve dili Adım 6'da.
> - `components/listbox.tsx` hiçbir yerden import edilmeyen ölü bir demo; stil yazılmadı, Adım 11'de silinecek.

**Dosya:** `theme-monolith.css` (PRIMEREACT OVERRIDES bölümü)
- **Buton:** varsayılan butonlar fiziksel tuş gibi görünür (`--bezel-raised`, 1px üst ışık çizgisi, basılınca iç gölge). Birincil buton aksan dolgulu. Tehlikeli eylem buton kırmızı kontur, hover'da dolgu alır. Text butonlar sessiz kalır.
- **Input, dropdown, multiselect:** gömülü ekran yüzeyi (`--screen` + iç gölge). Focus'ta `--focus-ring`.
- **Checkbox, slider, progressbar:** aksan.
- **Durum göstergesi:** `.p-tag` pill'leri yerine yeni `StatusLamp` bileşeni gelir (`components/shared/StatusLamp.tsx`): şekil + 8px lamba + metin. `.p-tag` yalnız etiket gibi nötr bilgi için kalır, köşeleri `3px` olur.
- **Dialog, menü, overlay, tooltip, toast:** radius hiyerarşisi ve gölge token'ları uygulanır. Dialog'daki `border-radius: 0 !important` kaldırılır. Toast'ta sol kenar şeridi yerine lamba kullanılır.
- **TabView ve paginator:** Dockview tab diliyle aynı görünüm.
- `:focus-visible` her etkileşimli öğede görünür olur. Şu an pek çok yerde `outline: none` ile kapatılmış.
- Modal maskesi neredeyse opak siyah, arkadaki uygulama kayboluyor. Maske ~%55 `--screen`'e iner. (denetim #14)

### Adım 4 — Uygulama kabuğu: title bar, sidebar, cluster bar, tab'lar ✅
> **Tamamlandı (2026-10-17).** Planlanandan farklı ya da fazla olanlar:
> - **Aktif öğe senkronu** `stores/activeViewStore.ts` ile; TabContext alanı değil, çünkü o context'in değeri her render'da yeniden kuruluyor ve sekme değişimine bağlı bir alan bütün listeleri yeniden render ederdi. Görünümü olmayan bir panel (YAML, log, terminal) odaktayken sidebar'da hiçbir şey işaretli değil; alt paneller hangi listeden açıldıklarını `params`'ta taşımıyor ve "Pods" işaretli kalması yanıltıcı olurdu.
> - **Overview** gruptan çıkıp sidebar'ın en üstüne, ayrı bir giriş öğesi olarak taşındı (`HOME_ITEM`, `NAV_ITEMS`). Grup ikonları ve kutulu rozetler kaldırıldı.
> - **Açılış sekmesi** `ClusterContext.loaded` gelene kadar bekliyor; tek bir "Overview • <cluster>" açılıyor. Overview ve Monitoring başlığındaki sahipsiz "• " de kaldırıldı (cluster adı yoksa hiç yazılmıyor).
> - **Bağlantı hatası:** yanıp sönen uyarı ikonu yerine `StatusLamp` (■ + "Connection error"); yeni çeviri anahtarı gerekmedi.
> - **Title bar'daki güncelleme ve port-forward düğmeleri** nötr tuş + lamba oldu; turuncu dolgu ve parlama kalktı. Port-forward lambası tünellerin durumunu (● / ▲ / ■) taşıyor.
> - **Ekran derinliği:** Dockview içeriğinin üst kenarına 6px'lik gölge `::after` ile çiziliyor, hiçbir panelin kendi boyamasına gerek yok. Cluster seçici de bir alan gibi gömülü.
> - ESLint'in i18n kuralına `tone` prop'u `severity`'nin yanına eklendi (tanımlayıcı, metin değil).
> - **Ertelenen:** sekme şeridi taştığında Dockview aktif sekmeyi görünür alana kaydırmıyor (`many-tabs.png`); bu Dockview davranışı, yeni değil. Dar pencerede sidebar'ın 240px sabit kalması Adım 12'de.
**Dosyalar:** `components/titlebar/TitleBar.tsx`, `components/menu/menu.tsx`, `components/menu/menuItems.tsx`, `components/cluster/ClusterBar.tsx`, `pages/main/appmain.tsx`, `components/workspace/FloatableTab.tsx`, `theme-monolith.css`
- **Çerçeve/ekran derinliği:** Dockview içerik kabı `--screen` olur ve üst kenarında iç gölge alır. Tab şeridi, sidebar ve title bar `--bezel` olur.
- **Title bar:** `KUBE INSPECTOR` yerine Plex Sans 600 ile sentence case "Kube Inspector" kelime markası ve logo. Menü öğeleri 13px olur. Update ve port-forward pill'leri lamba diline geçer; update pill'indeki parlama gölgesi kaldırılır.
- **Sidebar:**
  - Grup başlıkları kutulu büyük harf rozet yerine sade sentence case metin + chevron olur.
  - Öğe yüksekliği 28px olur.
  - Aktif öğe gradyan dolgu yerine "basılı tuş" görünümüne geçer (`--screen` zemin + 2px aksan çentiği).
- **Aktif öğe senkronu:** `menu.tsx`'teki lokal `activeView` kaldırılır. Aktif Dockview panelinin `view`'u `TabContext` üzerinden okunur, böylece tab değişince sidebar da güncellenir.
- **Açılış sekmesi:** `DockviewContainer.onReady`, ClusterContext yüklenmeden çalışıyor. Bu yüzden ilk Overview sekmesi `clusterName: ""` ile açılıyor (id `overview:`, içerikte sahipsiz "•") ve sidebar'dan Overview'a tıklanınca ikinci bir sekme açılıyor. Açılış sekmesi `activeCluster` gelene kadar bekler; boş cluster adında ayırıcı hiç yazılmaz. (denetim #1, #2)
- **Kapalı grupta `aria-expanded` yok:** `aria-expanded={!!expanded[group.key]}` olmalı. (denetim #4)
- **Tekrarlayan ikonlar:** her view kendine özgü bir ikon alır (replicasets, ingressclasses, namespaces, limitranges, networkpolicies). Overview grubun başına taşınır.
- **Sidebar kabuğu:** `appmain.tsx`'teki inline sidebar stilleri sınıfa taşınır. Hover ile açılan sidebar'ın gölgesi token'a bağlanır.
- **Cluster bar:** dropdown'ın sol kenarındaki cluster rengi korunur. Bağlantı hatası butonundaki `warn-pulse` döngüsü kalkar; yerine statik kırmızı lamba + "Bağlantı yok" metni gelir. ClusterBar'daki inline stiller sınıfa taşınır.
- **Dockview tab'ları:**
  - Aktif tab ekran rengiyle içeriğe kaynaşır (klasör sekmesi gibi).
  - Gradyan tint kaldırılır, 2px cluster şeridi korunur.
  - Kapat butonu yalnız hover'da ve aktif tab'da görünür.
  - Tab yüksekliği 34px olur.

### Adım 5 — Kaynak listeleri (21 liste ekranının hepsi) ✅
> **Tamamlandı (2026-10-17).** Planlanandan farklı ya da fazla olanlar:
> - **Toolbar:** başlık (e2e `<h3>`'e dayandığı için öğe ve metin aynı) + yanında sayı; filtre varken "12 / 142". Silme butonu seçim yokken hiç yok, seçim olunca "Delete 3" olarak beliriyor; e2e artık onu metinden değil `rlv-delete` sınıfından buluyor. Filtre temizleme butonu filtre yokken devre dışı.
> - **Pill fazlası temizlendi:** Ready/replicas/completion/data-key/kural sayıları yeni `CountCell` (düz tabular sayı, yalnız kötü haberse renkli); Owner ve Service tipi düz metin; "Default", NetworkPolicy ve LimitRange tipleri renksiz nötr etiket; CronJob durumu `StatusLamp`. Bu taşıma, `value` prop'unun arkasında saklanan çevrilmemiş metinleri ortaya çıkardı ("Suspended/Active", "Yes/No", "Exec into · N containers"); hepsi çevrildi.
> - **Satır eylemleri** ortak `RowAction` ile (zorunlu `label` → `aria-label` + `title`, ikon `icon` prop'unda). 11 liste ve pod listesinin Logs/Shell butonları geçirildi.
> - **Durumlar:** yükleme statik iskelet satırlar (`ListSkeleton`, `PanelSkeleton`; spinner yok), boş durum filtre yüzündense "Filtreleri temizle" eylemiyle, hata veri yokken tablonun yerini alan blok (hatanın tamamı mono, cluster adı başlıkta). Bant yalnız eski veri ekrandayken; kırmızı-üstüne-kırmızı yerine bezel zemin + hata lambası.
> - **Satır yüksekliği 32px** tek sabitte (`lib/tableMetrics.ts`). Events (46) ve CRD instance tablosu (40) sanal kaydırıcıya CSS'ten farklı yükseklik veriyordu; ikisi de bu sabite bağlandı. Events listesi de ortak toolbar/iskelet/hata diline geçti.
> - **Yeni satır vurgusu** yalnız *yeni* satırlar için: pod satırları her poll'da CPU/bellek değiştirdiği için "değişen satır" vurgusu listeyi sürekli yakardı.
> - **Ertelenen:** isteğe bağlı yoğunluk ayarı (`densityStore`) yapılmadı. Editör panellerindeki (ConfigMap/Secret/Role/RoleBinding) çizgili tablolar Adım 7'de. Delete dialog başlığı "Delete Configmap Confirmation" büyük/küçük harfi (kind adı) olduğu gibi.
**Dosyalar:** `components/shared/ResourceListView.tsx`, `components/shared/actionColumn.ts`, `lib/useResourceList.ts` (yalnız sayaç için), liste `main.tsx` dosyaları
- **Toolbar:** `<h3>` yerine 40px'lik toolbar gelir. Başlık 15px/600, yanında `--ink-3` ile "142 pod" sayacı, sağda aksiyonlar. Inline stiller sınıfa taşınır.
- **Tablo:**
  - `stripedRows` ve `showGridlines` kapatılır, yalnız yatay ince çizgiler kalır.
  - Satır 32px olur. Başlık sentence case olur.
  - Hover `--screen-2`, seçili satır aksan %10 + sol çentik.
  - Filtre satırı sessizleşir: 26px kontroller, placeholder `--ink-3`.
- **Kolon tipografisi:** tanımlayıcı kolonlar (image, IP, port) `.cell-mono` sınıfını alır. Status kolonu `StatusLamp` kullanır. Yaş/süre kolonları tabular ve sağa hizalı olur.
- **Durumlar** (tek bir ortak dil):
  - Yükleme: iskelet satırlar. `ProgressSpinner` yerine `PanelSkeleton` genişletilir.
  - Boş: ne olduğunu ve ne yapılabileceğini söyleyen metin + eylem ("Bu namespace'te pod yok", aktif filtre varsa **Filtreleri temizle** butonu).
  - Hata: mevcut `ErrorBanner` yeni token'larla yeniden stillenir.
- **Delete dialog:** sabit `30rem` genişlik yerine token'lı dialog. Listelenen nesneler Plex Mono ile, sayı sınırlı ("ve 12 tane daha").
- **İsteğe bağlı yoğunluk ayarı:** Kompakt 28px / Rahat 36px. `themeStore` yanına `densityStore` eklenir ve `html[data-density]` attribute'u ile uygulanır.
- Yeni gelen veya değişen satır için tek seferlik vurgu (600ms). `usePayloadSignature` mevcut ve kullanılabilir.
- **Pill fazlası:** Pods listesinde Status, Ready ve Owner kolonlarının üçü de renkli tag; her satırda bir turkuaz "Deployment" pill'i var. Owner düz metne, Ready tabular sayıya, Status `StatusLamp`'e geçer. (denetim #6)
- **Sıralama ikonu:** başlık metninden büyük ve her kolonda hep görünür. Küçülür; sıralanmamış kolonda yalnız hover'da görünür. (denetim #7)
- **"Delete Selected":** seçim yokken de devre dışı, kırmızı konturlu bir buton olarak duruyor. Seçim olunca "3 öğeyi sil" olarak belirir. (denetim #8)
- **Hata durumu:** bugün bandın altında boş bir tablo kalıyor ve bant kırmızı zemin üstünde kırmızı yazı. Hata durumu tablonun yerini alır: ne oldu, hangi cluster, Retry / Copy diagnostics eylemleri, ayrıntı açılır bölümde. (denetim #9)
- **Satır eylem butonlarının adı yok:** Logs ve Exec butonlarında `title` / `aria-label` yok ve `p-button-icon-only` sınıfını taşımıyorlar. `actionColumn.ts`'te topluca düzeltilir. (denetim #5)

### Adım 6 — Panolar: Overview, Monitoring, Nodes ✅
> **Tamamlandı (2026-10-17).** Planlanandan farklı ya da fazla olanlar:
> - **Yeni ortak parçalar:** `shared/Gauge.tsx` (CSS enstrüman göstergesi: %10 çentikli gömülü iz, %60/%80 eşik işaretleri, ibre; `compact` varyantı node satırları için; `role="meter"`), `shared/NoMetrics.tsx` (sarı bant yerine sakin "veri yok" + kurulum ipucu), `shared/Segmented.tsx` (radiogroup, ok tuşlarıyla). `lib/usage.tsx`'e `usageTone()` eklendi; çubuklar artık çözülmüş renk değil sınıf taşıyor, tema değişince yeniden render gerekmiyor.
> - **chart.js'ten çıkanlar:** Monitoring'in node satırları ve Nodes kartındaki kullanım çubukları canvas'tı; ikisi de `Gauge` oldu. chart.js yalnız trend grafiklerinde kaldı (lejant kapalı, %8 dolgu, yalnız soluk yatay ızgara).
> - **Overview:** beş özdeş kart yerine dikey çizgilerle ayrılmış tek sayaç şeridi; etiketler sidebar'ın çevrilmiş adlarından (`NAV_ITEMS`), böylece "Nodes" ve `Open ${title}` sabitleri kalktı. Node'lar lamba + ad + sürüm + iki kompakt gösterge satırı. Hiç veri yokken hata bloğu.
> - **Nodes:** 41 inline stilden 5'e (kalanlar dialog içinde). Bellek `mem_capacity_mi`'den ("30.8 GiB"), İngilizce "CPU Cap/MEM Cap" diğer dillerle aynı "CPU capacity/Memory capacity" oldu. Cordon/Uncordon nötr tuş, Drain tek tehlike rengi; Shell ve YAML adlı `RowAction`. Toast'lar ve "Unschedulable" etiketi i18n'e alındı (9 yeni anahtar × 6 dil); toolbar sayacı "1 of 1 ready".
> - Kullanılmayan üç `noMetricsServer` anahtarı 6 dilden silindi.
> - **Ertelenen:** Monitoring'in zaman penceresi seçenekleri ("5 min", "1 hour"…) hâlâ İngilizce sabit; Adım 12'deki uzun metin/i18n turuna. Monitoring tablosunun filtre menüsü ikonları büyük; Adım 7/12.
**Dosyalar:** `components/overview/main.tsx`, `components/monitoring/main.tsx`, `components/node/main.tsx`, `lib/usage.tsx`, `lib/LiveChart.tsx`, `components/pod/detail/UsageChart.tsx`
- **Overview:**
  - Birbirinin aynısı kart ızgarası yerine tek bir **okuma şeridi** gelir: dikey çizgilerle ayrılmış sayaçlar, tıklanınca ilgili listeyi açar.
  - Kapasite **enstrüman göstergesi** olarak çizilir: tik işaretli yatay skala, %60/%80 eşik çizgileri, ibre değeri.
  - Node'lar kart yerine yoğun tablo/listeye geçer: lamba + ad + sürüm + CPU/MEM mini göstergeleri.
  - Sabit metinler i18n'e alınır (`"Nodes"`, `` `Open ${t.title}` ``).
- **Monitoring:**
  - Gradyanlı ve zıplayan `mon-switch` yerine segmentli düz bir anahtar gelir.
  - Grafikler: 1.5px çizgi, %8 alan dolgusu, ızgara çizgileri yalnız yatay ve çok soluk. Birincil seri aksan, ikincil seri `--info`.
  - Detay çekmecesi (drawer) çerçeve yüzeyine geçer.
- **Nodes:** kart düzeni korunur ama ölçülü bir panel diline geçer: cordon/drain eylemleri tuş stilinde, durum lamba ile. 41 inline stil sınıfa taşınır.
- `getUsageColor` eşikleri aynı kalır, renkler `--ok/--warn/--err` olur.
- **metrics-server bandı:** tam genişlik doygun sarı bir hata bandı. Kapasite göstergesinin yerinde sakin bir "veri yok" durumuna dönüşür, kurulum ipucu ikincil satırda yer alır. (denetim #10)
- **Node bellek kapasitesi:** "32326340Ki" olarak ham basılıyor; `mem_capacity_mi`'den "30.8 GiB" gösterilir. "MEM Cap" / "CPU Cap" etiketleri "Memory" / "CPU" olur. (denetim #11)
- **Node kartı eylemleri:** dört eylem dört farklı renkte. Tuş stiline geçer; yalnız Drain tehlike rengini alır. (denetim #12)

### Adım 7 — Detay ve araç panelleri ✅
**Dosyalar:** `components/pod/detail/*`, `workspace/YamlEditorPanel.tsx`, `ApplyYamlPanel.tsx`, `ObjectYamlPanel.tsx`, `DescribePanel.tsx`, `logs/*`, `terminal/*`, `diagnostics/*`, `portforward/PortForwardsPanel.tsx`, `security/TrivyScanner.tsx`, `security/SecurityRoleMap.tsx`, `networkpolicy/PolicyViewerPanel.tsx`, `crd/*` (+ `crd.css`), `clusterresource/ClusterResourcePanel.tsx`
- **Pod detail:** başlık bandı çerçeve rengine geçer. Bölüm başlıkları gri bant yerine sade başlık + ince çizgi olur. `pd-badge`'ler 3px radius'la etiket diline geçer.
- **YAML, log ve terminal:** üçü de `--screen-dark` ekran kullanır. Toolbar'ları ortak bir `PanelToolbar` sınıfında birleştirilir (36px). Log seviyesi renkleri durum token'larına bağlanır.
- **Trivy:** yanıp sönen caret statik olur. Önem dereceleri (critical/high/…) lamba + metinle gösterilir. `✓` gibi glifler i18n'e alınır.
- **Security Role Map, Policy viewer, Cluster resource graph (reactflow):** düğüm ve kenar renkleri token'lardan alınır, MUI kalıntıları çıkarılır. 59 ve 45 inline stil sınıfa taşınır. `"✕ blocked"` i18n'e alınır. **Kategori renkleri durum token'larını kullanıyor:** `ClusterResourcePanel` (Ingress=`--err`, Service=`--warn`, Deployment=`--ok`…), `SecurityRoleMap` (Role=`--ok`, RoleBinding=`--warn`…). Bir Ingress "hata" değildir. Grafikler için ayrı bir kategori paleti (`--cat-1..6`) tanımlanır, durum renkleri yalnız durum için kalır. reactflow minimap'i koyu temada açık gri bir kutu ve zoom kontrolleri beyaz; ikisi de token'lara bağlanır.
- **Diagnostics ve Port-forward panelleri:** `diag-pill` ve `pf-overlay__dot` lamba bileşenine geçer. Bölüm başlıklarındaki büyük harf kaldırılır.
- **Dar pod detayı:** 900px'te etiket/değer ızgarası kelimeleri harf harf bölüyor ("Re pl ic aS et"). Panel ~420px altına inince etiket üstte, değer altta düzenine geçer. Kimlik değerleri ellipsis + kopyala ile gösterilir. (denetim #13)
- **Log toolbar'ı:** etiketsiz 5 ikon toggle ve hep görünen "0 matches". Toggle'lar etiketli bir segmentli gruba toplanır; sayaç yalnız arama varken görünür. (denetim #15)

> **Yapılan (planla farkları):**
> - **Grafik panelleri** (Role Map, Policy viewer, Cluster resources): `--cat-1..6` kategori paleti eklendi (`themeColors.ts` + 3 tema). Durum renkleri yalnız durum için kaldı. Düğümler ortak `.graph-node` dilinde. Vurgu parlama yerine `is-focus` / `is-chain` sınıflarıyla; kenar animasyonları kalktı. Minimap, zoom tuşları ve arka plan ortak `GraphChrome` bileşeninde. reactflow'un CSS'i bizden sonra yüklendiği için kurallar `.react-flow` önekli. ClusterResourcePanel'de renk olarak değişken adı (`cfg.color`) kullanan eski bir hata da düzeldi.
> - **MUI planlanandan erken (Adım 11 yerine burada) kaldırıldı.** Tek kullanımı spinner'dı; yerine `shared/Spinner.tsx` geldi. `@mui/material` ve `@emotion/*` package.json'dan silindi.
> - **Pod detayı:** başlık bezel'e geçti ve liste toolbar'ı ile aynı hizada (40px). "Pod" etiketi aksan yerine `--ink-3`. Bölüm başlıkları sade metin + çizgi. CPU/Memory sekmeleri `Segmented` oldu. Durum lamba ile gösteriliyor. Başlık butonları `RowAction` (yeni `severity="danger"`). Yükleme `Spinner` ile. **Dar düzen:** `container-type: inline-size` + `@container pod-detail (max-width: 420px)` ile etiket üstte, değer altta.
> - **Log toolbar'ı:** beş toggle tek bir tuş grubunda. Basılı tuş = gömük zemin + aksan çentiği, `Segmented` ile aynı işaret. Etiketler `aria-label` + tooltip olarak duruyor; görünür metin eklenmedi, çünkü toolbar 900px'e sığmıyordu. "0 matches" artık yalnız arama kutusu doluyken görünüyor (`:has(:placeholder-shown)`).
> - **Trivy:** imleç sabit. Önem dereceleri `StatusLamp`. Renkli kutucuk ızgarası yerine hizalı bir özet tablosu: sıfırlar soluk, başlıkta lambalar. Bulgu dialog'undaki öneri kutusu `--info` kenar çizgisine dönüştü. Konsol ve bildirim metinlerinin hepsi i18n'e alındı (16 anahtar, `✓` dahil). Inline stil 33'ten 18'e indi; kalanlar kolon genişliği.
> - **Port-forward:** liste toolbar diline geçti. Satır butonları `RowAction` (yeni `loading`). Durumlar çevrildi. Hata alt bilgisi lamba + mesaj olarak gösteriliyor. Title bar pill'indeki nokta `StatusLamp markOnly` (etiket ekran okuyucuya kalıyor). Inline stil 26'dan 9'a indi.
> - **Diagnostics:** sağlık kontrolü sonucu lamba ile ve çevrilmiş. Log seviyesi rozet yerine renkli mono kelime. Rol/logger kolonlarındaki mor/mavi gökkuşağı kalktı. `pi` ikonları Vsc oldu; uygulamada `pi pi-` kalmadı.
> - **Editörler** (ConfigMap/Secret/Role/RoleBinding): toolbar tablo başlığından ortak `panel-toolbar`'a çıktı, çizgi/ızgara kalktı. Satır silme `RowAction` ("Kaldır" adıyla). Secret göster/gizle butonu da adlandırıldı. Boş durum, ekleme butonunu doğrudan içeriyor; metinler "Bu ConfigMap'te anahtar yok." biçiminde. `kv-*` sınıfları.
> - **Describe / Apply YAML:** `panel-toolbar`. Describe `--screen-dark` ekranında ve yüklemesi iskelet. **Hata düzeltildi:** Apply çıktısı başarılı olduğunda da `--warn` sarısıyla yazılıyordu; artık sonuca göre lamba + renk. Bildirimler çevrildi. Bölücü `graph-divider` ile aynı.
> - **CRD:** üst şerit liste toolbar'ı gibi. Sayı rozet yerine düz sayaç. Scope/version nötr etiket (cluster-scoped bir uyarı değil). Ağaçta aksan yalnız seçimde. Satır ve toolbar butonları `RowAction`. Toplu silme yalnız seçim varken görünüyor. Hata `ErrorBanner` ile. Delete dialog'u listelerinkiyle aynı (`rlv-delete-dialog`, 8 isimden sonra "ve N tane daha").
> - **Yeni ekran senaryoları:** `capture.py`'e `pod-describe`, `configmap-editor` ve `crd-instances` eklendi.
> - **Görüntülerden çıkan iki düzeltme:**
>   - Trivy tablolarının üstünde lara'nın `#1f2937` slate rengi mavi bir bant olarak duruyordu. `.p-datatable-header` / `footer` / `tfoot`, kolon filtre menüsü ve dropdown filtre başlığı token'a bağlandı.
>   - Dar pod detayında "ReplicaS / et" bölünmesi `.pd-ref__kind` için `nowrap` ile kalktı.
>   - Lara'nın bu rengi 98 yerde kullanıyor; tam envanter Adım 10'da (açık tema). Tarama: lara'da `background: #1f2937` olan her seçici, bizde aynı seçiciyle `background` veriyor mu?
> - **Ertelenen:** `style={{` 397 (hedef ≤250). Kalanların neredeyse tamamı DataTable kolon genişliği (`pod/main` 37, `events` 21…), renk içeren inline stil 0. Kolon genişliği bir düzen kararı, sınıfa taşımak kazanç getirmiyor; hedef Adım 11'de yeniden değerlendirilecek. `PortForwardDialog` ve `ChangelogNotes`'ta `ProgressSpinner` kaldı (Adım 8). `trivy-blink` keyframe'i yalnız AI araç noktası için duruyor (Adım 8).

### Adım 8 — Modallar ve yüzen pencereler ✅
**Dosyalar:** `cluster/ClusterModal.tsx`, `cluster/AboutModal.tsx`, `titlebar/UpdateModal.tsx`, `titlebar/ChangelogNotes.tsx`, `ai/AiChat.tsx`, `tour/TourCard.tsx`, `lib/tourSteps.ts`, `climode/*`
- **About ve Update:** ortalanmış "yuvarlak kutuda logo + pill sürüm" kalıbı kalkar. Yerine sola hizalı başlık + sürüm tablosu (mevcut → yeni) gelir. Update adımları sade bir ilerleme çizgisiyle gösterilir. Butonlar ortak buton primitifine geçer (`update-modal__btn` ve `about-modal__close-btn` gibi özel butonlar kaldırılır).
- **Cluster modal:** etiketler sentence case olur. İstatistik kutucukları satır içi sayaç olur. Editör `--screen-dark` kullanır.
- **AI asistanı:** balonlu sohbet yerine **konsol günlüğü** görünümü gelir:
  - Mesajlar sola hizalı, rol işaretiyle (kullanıcı satırı aksan çentikli).
  - Araç çağrıları enstrüman log satırı olarak.
  - Zıplayan noktalar yerine "Çalışıyor · 4 sn" gibi metin tabanlı bir sayaç (döngü animasyonu değil).
  - `⚠️` yerine ikon kullanılır.
- **Tur:** emoji ikonlar `react-icons/vsc` ikonlarıyla değiştirilir. Kart yeni popover diline geçer.
- **CLI overlay:** `--screen-dark`, Plex Mono.
- **AI penceresi:** altındaki içerikle aynı zemin rengini kullanıyor ve gölgesi yok. Yüzen pencere `--bezel` ve `--shadow-3` alır. (denetim #16)

> **Yapılan (planla farkları):**
> - **Ortak dialog dili** (`theme-monolith.css`):
>   - `.dlg-facts` etiket/değer listesi. Etiket kolonu 9.5rem sabit; böylece bir dialog'daki iki liste hizalı duruyor.
>   - `.dlg-section` bölüm başlığı, `.dlg-actions` footer butonları.
>   - `.dlg-form` / `.dlg-field` / `.dlg-label` / `.dlg-note` / `.dlg-error` form kalıbı.
>   - Liste çizgileri `--line-strong`: `--line`, dialog'un yükseltilmiş zemininde görünmüyor.
> - **About:** standart dialog. Başlık "Kube Inspector hakkında", ardından açıklama ve mono değerli bilgi listesi (sürüm, yazar, Go, bağımlılıklar). Logo kutusu, sürüm pill'i ve özel butonlar kalktı.
> - **Update:**
>   - Başlık dialog başlığına çıktı. Logo kutusu yerine "Kurulu / Yeni sürüm" bilgi listesi var.
>   - Numaralı daireler yerine iki parçalı bir ray (`update-rail`): biten parça ink, süren parça aksan.
>   - İndirme yüzdesi çubuğun içinde değil, durum satırında tabular rakamla.
>   - Butonlar footer'da ortak `Button`. Her durumda tek bir birincil eylem var.
>   - Hata metni kırmızı yazı yerine kırmızı kenar çizgisiyle.
>   - Akış mantığına dokunulmadı.
> - **Cluster modal:**
>   - Etiketler sentence case (en/tr).
>   - İstatistik kutucukları, Overview'daki gibi tek satırlık okuma şeridi oldu. ru/zh'de sayıya göre çekimlenmiş ("кластеров", "个集群") etiketler yalın hale getirildi.
>   - Geçerli/Geçersiz bilgisi lamba ile gösteriliyor. Kubeconfig editörü `--screen-dark`.
>   - Aksan yalnız seçimde kaldı: önerilen ad çipi, current-context ve küme ikonları nötr.
>   - Kapat ve "Dosya seç" ortak butona geçti.
>   - **Hata:** native `<dialog>`'un tarayıcıdan gelen 1em iç boşluğu başlık bandını ikinci bir çerçevenin içine itiyordu; sıfırlandı.
> - **AI asistanı:**
>   - Balonlar yerine `--screen` üstünde bir konsol günlüğü. Kullanıcı satırı aksan çentikli ve "Siz" işaretli; asistan metni düz.
>   - Araç çağrıları lamba + mono ad + çevrilmiş durum (Çalışıyor/Tamamlandı/Reddedildi/Başarısız).
>   - Zıplayan noktalar yerine "Çalışıyor (4 sn)" sayacı.
>   - `⚠️` kalktı: hata artık mesajın ayrı `error` alanı ve lamba + metin olarak gösteriliyor. Store tipine isteğe bağlı bir alan eklendi; eski kayıtlar olduğu gibi okunuyor.
>   - Onay kutusu warn kenar çizgili. "Onayla" `danger` rolünde, çünkü silme/uygulama çalıştırıyor.
>   - Başlık ve model satırlarındaki ikon butonları `RowAction` (hepsine erişilebilir ad verildi). Model kartları yerine çizgili satırlar.
>   - Boş sohbet metni sadeleşti (en/tr).
> - **Tur:**
>   - Emojiler, adımın işaret ettiği öğenin kendi Vsc ikonuyla değişti (küme → `VscServer`, sidebar → `VscListTree`…).
>   - İlerleme çubuğu yerine "Adım 2 / 7" sayacı. Yeşil "Bitir" tuşu kalktı; butonlar ortak.
>   - Başlıklar sentence case.
>   - **Bilinçli dokunulmadı:** `workspace` adımının seçicisi `'tour-workspace'` (`#` yok). `3788a16 "tour fixes"` commit'inde böyle yapılmış; muhtemelen kartı ortada göstermek için. Doğrulanması gerekiyor.
> - **CLI overlay:** 9 inline stil yerine `panel-toolbar` + `cli-overlay` sınıfları. Alt başlıktaki "— terminal UI" tire kalıbı 6 dilde kaldırıldı.
> - **Adım 7'den devreden:** `PortForwardDialog` dialog form diline geçti. Çevrilmemiş "Custom…" etiketi i18n'e alındı, " · " ile birleşik başlık satırı kalktı. `ChangelogNotes` artık `Spinner` kullanıyor. Uygulamada `ProgressSpinner` kalmadı. `trivy-blink` keyframe'i silindi.
> - **Ertelenen:** `.p-progress-spinner-circle` override'ı artık kullanılmıyor, Adım 11'de silinecek.

### Adım 9 — Hareket ✅
**Dosya:** `theme-monolith.css` + ilgili bileşenler
- Döngüler kaldırılır: `warn-pulse`, `ai-bounce`, `trivy-blink` (caret ve `ai-tool--running`). Yalnız `err-banner-spin` gibi gerçek işlem spinner'ları kalır.
  > Adım 4, 7 ve 8'de yapıldı: üçü de kalktı, `grep infinite` yalnız spinner'ları buluyor.
- `* { scroll-behavior: smooth }` global kuralı kaldırılır. Yoğun bir veri aracında tablo ve log kaydırmasını yavaşlatıyor; yalnız gerekli kaplarda bırakılır.
- Menü, popover ve dialog için tek bir giriş eğrisi tanımlanır: `--ease-out`, 140ms.
- Açılış imzası: `#root` ilk boyamada ekran parlaklığını 400ms'de açar. Tek seferliktir ve yalnız ilk yüklemede çalışır.
- Global bir `@media (prefers-reduced-motion: reduce)` bloğu tüm geçişleri kapatır.

> **Yapılanlar:**
> - **Kaydırma:** Global `smooth` kuralı ve onu dockview tab şeridinde geri alan istisna kalktı. Hiçbir kapta bırakılmadı. `scroll-behavior` tekerlek/trackpad kaydırmasını etkilemiyor, yalnız koddan gelen kaydırmayı etkiliyor. Bunların hepsinin anlık olması gerekiyor: log ve AI konsolunun son satırı izlemesi, Describe'ın poll sonrası konumunu geri yüklemesi. Selenium ölçümü: `smooth` kalan öğe 0.
> - **Token'lar** (`:root`): `--ease-out` `cubic-bezier(.2,.8,.2,1)`, `--ease-in`, `--dur-in` 120ms, `--dur-out` 90ms, `--dur-move` 200ms.
>   - **Plandan sapma:** süre 140 değil 120ms. PrimeReact'in overlay `CSSTransition`'ı `-enter-active` sınıfını 120ms'de kaldırıyor; daha uzun bir geçiş o noktada kesilirdi.
> - **Açılış/kapanış dili:** PrimeReact'in dört farklı hareketi tek dile indirildi. Önceden dropdown %80 yükseklikten büyüyordu, dialog %70'ten zoom yapıyordu, context menu 250ms soluyordu, toast 300ms'de yarım boy yükseliyordu. Şimdi:
>   - Overlay'ler `scaleY(.96)`'dan büyüyor. PrimeReact `transform-origin`'i alana değen kenara koyduğu için, panel yukarı açıldığında da doğru yerden büyüyor.
>   - Dialog `translateY(4px) scale(.985)`'ten geliyor.
>   - Toast 6px'ten geliyor; kapanırken altındakiler boşluğu kapatıyor.
>   - Maske süreleri token'a bağlandı.
>   - Override'lar özgüllük artırmadan kazanıyor, çünkü PrimeReact'in kendi kuralları `@layer primereact` içinde ve katmansız CSS her katmanı yener.
>   - ContextMenu'nün timeout'u 0 olduğu için geçiş sınıfı hiç görünmüyor; ona aynı eğriyle bir keyframe (`surface-in`) verildi.
>   - Satır menülerindeki ayrı `exec-menu-in` keyframe'i, connected-overlay geçişiyle çift oynadığı için silindi.
> - **Yerleşim hareketleri:** sidebar açılması, workspace kayması, gauge ibresi/dolgusu, mon-bar, AI model çubuğu, chevron ve caret dönüşleri `--dur-move`/`--dur-in` + `--ease-out`'a bağlandı.
> - **Açılış imzası:** `#root` yerine yalnız ekranlar (`.dv-content-container`) aydınlanıyor. Bütün arayüz birlikte solsaydı sıradan bir fade-in olurdu. Bu hâliyle çerçeve hemen görünüyor, ekranlar 80ms sonra 400ms'de `brightness(.3)`'ten açılıyor.
>   - `lib/motion.ts::markBoot()` ilk render'da `<html data-boot>` koyuyor, 1.2s sonra kaldırıyor. Sonradan açılan ya da bölünen panel animasyonsuz geliyor.
>   - Fill mode `backwards`: animasyon bitince kalan bir `filter`, ekranı `position: fixed` çocukları için containing block yapardı.
>   - Ölçüm: animasyon 236ms'de `screen-on 0.4s` ile çalışıyor; 2.5s'de `none`.
> - **Hareket azaltma:** dosyanın sonunda global blok var. Tüm geçiş ve animasyonlar 1ms'de bitiyor; `none` değil, böylece son durum korunuyor ve `animationend` yine geliyor.
>   - İstisna `.spinner`, `.err-banner__spin` ve belirsiz ProgressBar: yavaşlayarak dönmeye devam ediyorlar. Durursa uygulama donmuş gibi görünür.
>   - xterm ve Monaco imleci CSS'in dışında çiziliyor. `prefersReducedMotion()` ile yanıp sönmesi kapatılıyor (`xtermOptions`, `CliModeOverlay`, `MONACO_BASE_OPTIONS.cursorBlinking`).
>   - Selenium CDP emülasyonuyla doğrulandı: dropdown/dialog `0.001s`, spinner `1.6s infinite`.
> - **Bilerek bırakılanlar:**
>   - `.12s` hover geçişleri, tepkisel mikro geri bildirim oldukları için olduğu gibi kaldı.
>   - Yeni satır vurgusu (`rlv-row--new`), azaltılmış harekette görünmüyor.

### Adım 10 — Temalar: açık tema + mevcut temaların taşınması ✅
**Dosyalar:** `stores/themeStore.ts`, `theme-monolith.css`, `lib/monacoTheme.ts`, `lib/xtermTheme.ts`
- `THEMES`'e `sodium` (varsayılan, yeni) ve `daylight` (açık) eklenir. Mevcut `monolith` kimliği eski kullanıcılar için kalabilir ya da `sodium`'a migrate edilir. Karar: `coerceTheme` + `migrate` ile `monolith` → `sodium`.
- `last-samurai` ve `god-of-war` blokları yeni token adlarıyla yeniden yazılır. Kendi karakterleri korunur, `--screen` ve `--bezel` ayrımını kazanırlar.
- **Açık tema için lara-dark-cyan'ın sabit renkleri:** adım 0'daki envanterdeki her PrimeReact bileşeni için token'a bağlı override yazılır. `color-scheme: light` verilir. Kod, log ve terminal ekranları koyu kalır.
- Electron'da `prefers-color-scheme` ile ilk açılış teması önerilir. Kullanıcı seçimi her zaman önceliklidir.
- `CLAUDE.md`'deki "Themes" bölümü yeni token adlarıyla güncellenir.

> **Yapılanlar:**
> - **Kimlikler:** Varsayılan `monolith` → `sodium` oldu. `daylight` eklendi. Store `version: 3`; `coerceTheme` eski `monolith`'i `sodium`'a çeviriyor (Selenium'la doğrulandı).
> - **İşletim sistemi önerisi:** Kayıtlı tema yoksa `prefers-color-scheme` light ise `daylight`, değilse `sodium` uygulanıyor.
>   - Öneri kaydedilmiyor: kullanıcı seçene kadar işletim sistemini izliyor, seçim her zaman önde (doğrulandı).
>   - Bootstrap öneriyi de ilk boyamadan önce uyguluyor; açık modda ilk kare koyu gelmiyor.
> - **Daylight:**
>   - Alüminyum çerçeve `#e3e6e8`, ekran `#f7f8f8`, yazı `#1f2326`.
>   - Aksan `#9e5709`. Plandaki `#a65c0a` çerçeve üstünde 4.0:1 kalıyordu; bir ton koyulaştırıldı.
>   - Durum renkleri beyaz zeminde AA için koyulaştırıldı. `--cat-*` ve `--ansi-cyan` açık zemine göre ayarlandı.
> - **Koyu ekran kapsamı:** Kod, log ve terminal açık temada koyu kalıyor.
>   - `:root` bloğunun seçicisi `html[data-theme="daylight"] .dark-display` ile de eşleşiyor, yani paletin tamamı orada koyu değerlere dönüyor: yazı, seçim, ANSI, Monaco widget'ları.
>   - `dark-display` alan yüzeyler:
>     - log gövdesi;
>     - Describe metni;
>     - Apply çıktısı;
>     - terminal ve exec;
>     - CLI overlay;
>     - Monaco yükleme yeri.
>   - Toolbar'ları açık temada açık kalıyor.
>   - Monaco ve xterm renkleri gizli bir `.dark-display` probundan okuyan `displayColor()` ile çözüyor.
> - **`--well`:** Ekran içindeki gömülü iz için yeni token (gauge skalası, minimap, alıntılanan hata, kubeconfig alanı, AI onay argümanları). Koyu temalarda `--screen-dark` ile aynı, açık temada açık gri.
> - **Derinlik token'ları:** 30 sabit siyah gölge `--recess`, `--press`, `--key-lift`, `--accent-lift`, `--screen-shade` ve `--shadow-*`'e taşındı. Daylight bunları grafit tonunda ve hafif tanımlıyor.
> - **lara envanteri:**
>   - lara'nın bileşen kuralları `@layer primereact` içinde. Bu yüzden katmansız kurallarımız özgüllükten bağımsız kazanıyor; sızıntı yalnız hiç değer vermediğimiz özelliklerde oluyor.
>   - `scripts/lara-tokens.mjs` (`npm run theme:lara`), lara'nın kullandığımız bileşenlerdeki her sabit rengini token'a çevirip aynı katmanda yeniden yazıyor: `src/theme-lara-tokens.css`, ~350 kural.
>   - Sonuç lara'yı eziyor, bizim kurallarımıza yeniliyor.
>   - Sızıntı taraması öncesi: tablo başlığı arkasında slate `#1f2937`, multiselect placeholder'ında beyaz yazı. Sonrası: 0.
>   - **Düzeltme:** CLAUDE.md'deki "lara specificity trap" notu ve Adım 9'da eklediğim "lara katmanlı değil" cümlesi yanlıştı; ikisi de düzeltildi.
> - **Last Samurai ve God of War:**
>   - Neredeyse siyah ekranlar kahverengi-lake ve kül-arduvaz tonlara kaldırıldı. Karakter korunuyor.
>   - Ekran–çerçeve farkı belirginleşti.
>   - `--ink-3` 3.95 ve 3.45'ten 5.5 ve 5.3'e çıktı. Samurai aksanı çerçeve üstünde 4.5:1'e getirildi.
>   - İkisi de artık ayrı bir `--screen-dark` alıyor.
> - **Doğrulama:**
>   - Daylight'ta 42 ekran, diğer üç temada 7 ekran çekildi.
>   - Kontrast oranları WCAG formülüyle hesaplandı.
> - **Bilerek bırakılanlar:**
>   - Küme renkleri (kullanıcının seçtiği kimlik renkleri) açık zeminde orta tonlu kalıyor.
>   - Tur spot maskesi koyu kalıyor.
>   - Diagnostics değer listesinin büyük mono yazısı temadan bağımsız; Adım 12'ye not.

### Adım 11 — Temizlik ✅
- **Ölü kod:** `components/listbox.tsx` (hiçbir yerden import edilmiyor) silinir.
- **MUI kaldırılır:** denetime göre MUI yalnız `CircularProgress` için kullanılıyor (`PanelLoading`, `PolicyViewerPanel`, `ClusterResourcePanel`, `SecurityRoleMap`). Dördü de ortak spinner'a geçer, sonra `@mui/material`, `@emotion/*` silinir. `CLAUDE.md`'deki "PrimeReact + MUI" ifadeleri düzeltilir.
- ~~**Kullanılmayan fontlar kaldırılır:** `@fontsource/inter`, `geist`, `outfit`, `jetbrains-mono`, `assets/fonts/nunito-*`.~~ Adım 2'de yapıldı.
- **lara'nın kendi Inter'i:** `lara-dark-cyan/theme.css` kendi `@font-face`'iyle `InterVariable.woff2` + italik (~0.7 MB) paketliyor. Hiçbir kural istemediği için çalışırken indirilmiyor ama dağıtıma giriyor. Açık tema için lara zaten override'larla eziliyor; tema dosyası yerine yalnız gerekli kısmı import etmek ya da Vite'ta bu iki `url()`'i boş bir dosyaya yönlendirmek değerlendirilir.
- **Kalan inline stil ve sabit renkler:** `grep -rn "style={{" | grep -E "#[0-9a-f]{3,6}|rgba"` boş dönmeli.
- **Dokümantasyon:** `docs/` sitesindeki uygulama ekran görüntüleri yenilenir, çünkü yeni kimlik eski görselleri geçersiz kılar. Website tasarım tercihine uygun kalınır: sakin, döngü yok.
- `graphify update .`

> **Yapılanlar:**
> - **Ölü kod:** `components/listbox.tsx` silindi. MUI Adım 7'de zaten kaldırılmıştı; `vite.config.ts`'teki artık `mui` vendor chunk'ı da silindi.
> - **lara'nın Inter'i:** `vite.config.ts`'e küçük bir `enforce: 'pre'` plugin'i (`stripLaraFonts`) eklendi. lara'nın iki `@font-face` bloğunu Vite `url()`'leri çözmeden siliyor. Build'de Inter dosyası 0 (önce ~0.7 MB).
> - **Kullanılmayan `ProgressSpinner` override'ı** silindi (Adım 8'den devreden).
> - **Inline stiller:** 369 → 300. Sabit renk taşıyan 0.
>   - Renk, yazı ve süs taşıyan ~70 stil sınıfa taşındı:
>     - pod listesi (kapsayıcı noktaları `.pod-dot` + `--dot`, exec seçici `.exec-item`);
>     - kota kullanım hücresi;
>     - Confirm / Scale / Namespace / Paste dialog'ları (ortak `dlg-*` diline);
>     - olay detayı (`dl.dlg-facts` + `.event-message`);
>     - node dialog'ları;
>     - tab başlığı (`.ftab`);
>     - terminal kapları (`.term-host`).
>   - Yeni ortak hücre dili: `.cell-empty`, `.cell-warn`, `.cell-err`, `.tag-list`, `.usage-cell`.
>   - Sidebar ikonlarının 30 `style={S}`'i `size={14}` oldu.
>   - Port-forward pill'indeki üç ikon buton `RowAction` oldu.
>   - Kota durumu `Tag` yerine `StatusLamp` gösteriyor (durum, etiket değil).
> - **≤ 250 hedefi:** Kalan 300'ün ~270'i DataTable kolon genişliği (`minWidth`/`maxWidth`). Geri kalanı veriden hesaplanan konum ve boyutlar: gauge ibresi, kullanım çubuğu, split yüzdesi, menü konumu. Bunları global CSS'e taşımak her görünümün kolon genişliğini stylesheet'e kopyalamak olurdu; temaya hiçbir faydası yok. Hedef "inline stilde renk/yazı yok" olarak kapandı.
> - **Dokümantasyon görüntüleri:** `roadmap/ui-redesign/docs_shots.py` ile 8 görüntü aynı ölçüde (3456×2108) yeniden çekildi: pods, deployments, monitoring, security-role-map, yaml-editor, split-view, terminal, vulnerability-scan.
>   - **Açık:** `network-policies.png` eski kaldı, çünkü kümede şu an NetworkPolicy yok. Bir tane oluşturmak kümeyi değiştirmek olacağı için yapılmadı.
>   - **Açık:** `docs/stylesheets/extra.css` hâlâ eski kimlikte (turkuaz aksan, Inter / JetBrains Mono). Yeni görüntüler bu çerçevede yabancı duruyor. Site paletinin yeni kimliğe taşınması bu planın dışında, karar bekliyor.
> - **Doğrulama:** Dönüştürülen bileşenler ekran görüntüsüyle kontrol edildi: kapsayıcı noktaları, exec seçici, scale / namespace / olay dialog'ları; olay dialog'u açık temada da.


### Adım 12 — Kalite kontrolü ✅
- **Kontrast:** her temada yazı/zemin çiftleri ölçülür (AA: gövde 4.5:1, UI 3:1). `--ink-3`'ün nerede kullanıldığı denetlenir.
- **Uzun metinler:** de/ru dillerinde sidebar, toolbar ve tablo başlıkları kontrol edilir (dosyanın sonundaki LONG-STRING DEFENCE kuralları korunur).
- **Dar pencere:** 900px ve altında title bar menüsü, liste toolbar'ı ve pod detail split'i.
- Klavye ile tam gezinti: focus ring görünür mü?
- Yeni ekran görüntüleri `python3 roadmap/ui-redesign/capture.py after` ile `roadmap/ui-redesign/after/` altına alınır (`THEMES=sodium,daylight,last-samurai,god-of-war`). Dosya adları `before/` ile aynı olduğu için yan yana karşılaştırılır. `audit.md`'deki sayısal başlangıç çizgisi tablosu yeniden ölçülür.
> **Yapılanlar:**
> - **Adım 11'den kalan iki açık:**
>   - **NetworkPolicy:** Kullanıcı onayıyla `cluster 2`'ye `default/allow-frontend-to-backend` uygulandı. Etiketi `app.kubernetes.io/part-of: kube-inspector-docs`; kümede `app=backend` pod'u olmadığı için trafiği etkilemiyor. `network-policies.png` yeniden çekildi; sitedeki 9 uygulama görüntüsünün hepsi artık yeni kimlikte. Silmek için: `kubectl delete networkpolicy -n default allow-frontend-to-backend`.
>   - **Dokümantasyon sitesi:** Yeni kimliğe taşındı.
>     - `docs/stylesheets/extra.css` Sodium token'larını `--ki-*` olarak aynalıyor: bezel başlık ve hero bandı, screen sayfa zemini.
>     - Accent yalnız Download tuşunda ve aktif sayfada. Linkler info mavisi.
>     - Fontlar IBM Plex (`mkdocs.yml` `theme.font` ve social kart).
>     - Kaldırılanlar:
>       - gradyanla kırpılmış 800 ağırlık başlık;
>       - aurora parıltısı ve turkuaz ızgara;
>       - parlayan ve yükselen gradyan CTA;
>       - büyük harf etiketler;
>       - pill çipler;
>       - kartların hover'da yükselmesi;
>       - sahte trafik lambası çerçevesi;
>       - changelog'daki neon ilerleme çizgisi ve parlayan düğümler.
>     - Logo, uygulamanın title bar işaretiyle aynı çizim: `docs/assets/mark.svg`.
>     - Mobilde yatay taşma yok. `mkdocs build --strict` temiz.
>     - İşletim sistemi uygulama ikonu (`build/appicon.png`) hâlâ turkuaz altıgen; bu plana dahil değildi.
> - **Kontrast:** Yeni `roadmap/ui-redesign/contrast_scan.py`, capture senaryolarındaki her görünür metni, arkasındaki gerçek (bileşik) zemine karşı ölçüyor.
>   - İlk tarama: 4 tema × 26 ekranda 38 başarısız çift.
>   - Kök neden: `--ink-3` yalnız `--screen` üstünde AA'ydı; çerçeve, dialog ve tooltip yüzeylerinde değildi.
>   - Düzeltmeler:
>     - `--ink-3`: Sodium `#9e9a92`, God of War `#88949f`, Daylight `#5c676f`. Artık her temada `--bezel-raised`'e kadar her yüzeyde ≥ 4.6:1. `--ink-2` ile kademe 1.34–1.47:1, hiyerarşi korunuyor.
>     - Daylight `--cat-*` renkleri bir ton koyulaştırıldı (graf düğüm etiketleri).
>     - CRD ağacında seçili satır `--bezel-high` üstünde olduğu için ikincil metni `--ink-2`.
>     - Cluster modal "Auto" anahtarı accent metin yerine ink + accent kenar.
>   - İkinci tarama: **0**.
> - **Uzun metinler (de/ru):** Sidebar, toolbar, tablo başlıkları, title bar menüsü ve cluster modal 1440 ve 900px'te çekildi (`step12/`). Kırılma yok.
>   - Almancada "KI-Assistent (experimentell)" menüde iki satır.
>   - 900px'te Status kolonu kesiliyor; kolonlar yeniden boyutlandırılabilir.
>   - Rusça "Список Events" çevirisi karışık; çeviri konusu.
> - **Dar pencere (900px):** Pod detayı alt alta düzene geçiyor, title bar ve liste toolbar'ı sığıyor.
> - **Klavye:** Pods ekranında 70 Tab durağı ölçüldü. İki gerçek eksik bulundu ve düzeltildi:
>   - **Title bar menüsü:** Odak `<ul>`'de kalıyor ve öğe `p-focus` almıyordu. Halka, öğe işaretlenene kadar listede.
>   - **Tablonun kaydırma bölgesi:** Tab durağı var ama halkası yoktu. Chromium yapışkan başlığı ve sabit kolonu, elemanın kendi outline'ından sonra boyuyor; bu yüzden halka `.p-datatable` üstünde `::after` katmanı olarak çiziliyor.
>   - Checkbox halkası zaten kutuya çiziliyordu (yanlış alarm).
>   - Gerçek fare tıklamasında menü halkası çıkmıyor. "After" görüntülerindeki halka capture'ın JS click'inden.
> - **After görüntüleri:** `after/` altında 4 tema × 42 ekran (168), atlanan yok.
>   - `compare/` altında 13 ekranın `before/monolith` ↔ `after/sodium` yan yana görseli var (gitignored).
>   - Denetim tablosu son sütunla güncellendi.



### Ek — Aksan rengi: turuncu → logo mavisi ✅
Turuncu sodyum aksanı kullanıcı geri bildirimiyle değiştirildi: butonlar ve çizgiler beğenilmedi, logoyla (`build/appicon.png`, `#69DBFF`) örtüşmüyordu.
- **Varsayılan tema:**
  - `--accent` `#58bde8`: logonun tonu (198°), grafit üstünde parlamasın diye bir kademe sakin.
  - `--on-accent` `#06151d`.
  - `--info` `#9ea6ec`: aksandan 36° uzakta mavi-lavanta, çünkü ikisi linklerde ve CPU/bellek grafiklerinde yan yana.
- **Daylight:** `--accent` `#1a6a96`, `--on-accent` `#f5fbff`, `--info` `#4f53ad`.
- **Değişmeyenler:** Zeminler, yazı renkleri, durum ve kategori renkleri. Last Samurai ve God of War aksanları da kaldı; onlar karakterli temalar.
- **Tema adı:** `sodium` → `graphite` ("Graphite"). `monolith` ve `sodium` kayıtları `graphite`'a taşınıyor; store `version: 4`.
- **Site:** `--ki-accent`, `--ki-info` ve `mark.svg` aynı maviye geçti. 9 site görüntüsü yeniden çekildi.
- **Doğrulama:**
  - Kontrast taraması 4 tema × 26 ekranda 0.
  - Migration Selenium'la doğrulandı.
  - `step-accent/` altındaki görüntüler incelendi.
- **Not:** Tab'ların üst şeridindeki renk aksan değil, kümenin kendi rengi ("cluster 2" için kırmızı). Cluster modal'dan değiştirilebilir.

---

## Yeniden kullanılacak mevcut parçalar
- `lib/themeColors.ts`: `themeColor`, `themeAlpha`, `useThemeVersion`. Canvas/xterm/Monaco'nun palete bağlanması için.
- `stores/themeStore.ts`: `THEMES`, `coerceTheme`, `migrate` ve senkron `bootstrap`. Açık tema ve migration için.
- `components/shared/ResourceListView.tsx` + `lib/useResourceList.ts`: 21 liste tek noktadan değişir.
- `components/shared/ErrorBanner.tsx`, `PanelSkeleton.tsx`, `PanelErrorBoundary.tsx`: durum dili için.
- `lib/usePayloadSignature.ts`: değişen veriye tek seferlik vurgu için.
- `--cluster-accent`, `--tab-accent`, `--dial-accent` inline custom property deseni: korunur.

## Doğrulama
- Her adımdan sonra `cd frontend && npm run typecheck && npm test && npm run lint && npm run i18n:check`.
- `make dev` ile Electron'da görsel kontrol: her temada değişen ekranların görüntüsü alınıp adım 0'daki "before" ile karşılaştırılır. `run` skill'i kullanılabilir.
- `make test-e2e`: e2e seçicileri `.p-tag` gibi sınıflara dayanıyorsa (`e2e_tests/helpers.py`) adım 3 ve 5'te birlikte güncellenir.
- Grep kapıları (adım 11 sonunda hepsi boş dönmeli):
  - `grep -rn "63,200,180" frontend/src`
  - `grep -rn "infinite" frontend/src --include=*.css` (spinner hariç)
  - `grep -rn "\-\-surface-\|\-\-text-color" frontend/src`
  - `grep -rn "@mui\|@fontsource/inter" frontend/src frontend/package.json`
- Erişilebilirlik: tarayıcı devtools'ta kontrast denetimi ve `prefers-reduced-motion` emülasyonu.
