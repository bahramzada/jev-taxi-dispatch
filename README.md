# JEV Taxi Dispatch — Bakı

Bakının real xəritəsi üzərində **real-vaxt taksi dispetçerlik simulyasiyası**.
Hər sifariş gələndə TypeSafe-in [JEV](https://docs.typesafe.ai/introduction) (System One)
modeli bir çağırışda dörd struktur qərar verir və sistem həmin qərarları dərhal tətbiq edir:
sürücü təyin olunur, saxta sifariş bloklanır, taksi real küçələrlə yola düşür.

Eyni sifarişlər istəyə görə paralel olaraq ənənəvi bir LLM-ə də göndərilir —
gecikmə, xərc və sxem etibarlılığı canlı müqayisə olunur.

![JEV Dispatch — əsas panel](docs/02-dispatch.png)

---

## Nə göstərir

JEV mətn yaratmır; tipli dəyər və ehtimal paylanması qaytarır. Dispetçerlik bu model
üçün təbii sahədir, çünki qərarlar kiçik, təkrarlanan və struktur olur:

| Sual | Tip | Nəticə |
|---|---|---|
| `surucu` | Choice | Ən yaxın 4 namizəd arasından seçim + ehtimallar |
| `tecililik` | Score | Sərnişinin mesajına görə 0–3 şkalası |
| `saxta_sifaris` | Noul | Saxta sifariş ehtimalı (0–1) |
| `xidmet_tipi` | Choice | standart / komfort / yük |

Dördü də **bir sorğuda, paralel** qiymətləndirilir.

### Qərar qapıları

Risk saxta sifarişdədir, ona görə qapı oraya qoyulub:

- `saxta ≥ 0.7` → sifariş bloklanır
- `0.4 ≤ saxta < 0.7` → insan yoxlamasına düşür
- `saxta < 0.4` → avtomatik təyinat

Sürücü seçimindəki aşağı confidence bloklama səbəbi deyil: iki sürücü eyni məsafədə
olanda hər iki seçim doğrudur, belə hallar sadəcə "yaxın nəticə" kimi işarələnir.

---

## Ölçülmüş nəticələr

Canlı sessiyadan (Bakı, ev internet bağlantısı, hər iki model eyni sifarişlərlə):

| | JEV | Gemini 3.5 Flash Lite |
|---|---|---|
| Median gecikmə | **363 ms** | 769 ms |
| p95 | 449 ms | 1238 ms |
| Xərc (1000 qərar) | **~$0.036** | ~$0.40 |
| Sxem pozuntusu | 0 | 0 |
| Razılaşma | 86% (eyni sürücü seçimi) | |

**Metodologiya** — rəqəmlərin ədalətli olması üçün:

- Hər iki model **eyni state, eyni sual mətnləri** və eyni anda alır
- LLM-ə `json_schema` structured output və `temperature: 0` verilir ki, formatlaşdırmaya
  görə uduzmasın
- Hər iki model **eyni keep-alive HTTP agent-indən** istifadə edir
- Sorğular növbə ilə gedir — eyni anda çoxlu sorğu uçuşda olanda ölçmə şəbəkə
  növbəsindən şişir
- Panel medianı son 25 sorğu üzrədir, soyuq başlanğıc nəticəni uzun müddət təhrif etmir
- LLM gecikməsinə OpenRouter marşrutlaşdırma vaxtı daxildir

Rəqəmlər sizin şəbəkənizdən asılıdır — layihəni işə salıb öz nəticənizi görə bilərsiniz.

---

## İşə salmaq

Node.js 20+ tələb olunur.

```bash
npm install
```

`.env` faylı yaradın:

```
JEV_API_KEY=sizin_jev_aciriniz
OPENROUTER_API_KEY=sizin_openrouter_aciriniz
```

`OPENROUTER_API_KEY` olmasa layihə yenə işləyir — sadəcə LLM müqayisəsi deaktiv olur.

```bash
npm start
```

→ http://localhost:3100

### Yol şəbəkəsini yeniləmək

`data/baku-roads.json` repoda hazır gəlir. Yenidən çıxarmaq üçün:

```bash
npm run fetch-roads
```

Overpass API-dən mərkəzi Bakının sürülə bilən yollarını götürür, oneway qaydalarını
tətbiq edir və yalnız ən böyük əlaqəli komponenti saxlayır (16,700 node / 25,128 kənar).

---

## Necə qurulub

```
server.js              Express — JEV və OpenRouter proxy-si, ədalətli ölçmə
scripts/fetch-roads    Overpass API-dən yol şəbəkəsinin bir dəfəlik çıxarışı
data/baku-roads.json   Yol qrafı (OSM, ODbL)
public/js/
  graph.js             Yol qrafı, məkan indeksi, A* marşrutlaşdırma
  map.js               MapLibre, gecə teması, 3D bina ekstruziyaları
  fleet3d.js           three.js custom layer — taksi modelləri və mayaklar
  sim.js               Simulyasiya döngüsü, sifarişlər, qərarın tətbiqi
  dispatch.js          API çağırışları, növbə, statistika
  hud.js               Panellər, qərar axını, sayğaclar
```

**Xəritə** — MapLibre GL JS üzərində [OpenFreeMap](https://openfreemap.org) "dark" stili
(API açarı tələb etmir). Bina hündürlükləri OpenMapTiles sxemindəki `render_height`
sahəsindən gəlir.

**Taksilər** — three.js custom layer daxilində proseduralla qurulmuş low-poly modellər
(hazır asset yoxdur). Mövqe Mercator koordinatlarına çevrilir, ölçü zoom-a görə
tənzimlənir. Xəritə həndəsəsi onları örtməsin deyə render-dən əvvəl dərinlik buferi
təmizlənir.

**Marşrutlar** — taksilər düz xətlə deyil, real yol qrafında A* ilə hesablanmış
marşrutlarla hərəkət edir. Marşrutlaşdırma brauzerdə işləyir, xarici API limiti yoxdur.

---

## Məlumat mənbələri

- Yol şəbəkəsi və xəritə: © OpenStreetMap contributors ([ODbL](https://www.openstreetmap.org/copyright))
- Vektor tile-lar: [OpenFreeMap](https://openfreemap.org) / OpenMapTiles
- Sifariş məlumatları simulyasiyadır — real sərnişin və ya sürücü məlumatı istifadə olunmur
