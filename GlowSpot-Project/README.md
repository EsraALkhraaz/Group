# GlowSpot — منصة حجز خدمات التجميل والعناية في ليبيا

نماذج تفاعلية (Prototypes) لمنصة GlowSpot، مكوّنة من أربعة تطبيقات منفصلة تتشارك نفس قاعدة البيانات.

---

## 📁 محتويات المشروع

```
GlowSpot-Project/
├── apps/            ← التطبيقات الأربعة (افتحيها بالمتصفح)
├── branding/        ← الشعار والهوية البصرية (النسخة المعتمدة)
├── documents/       ← الكتالوج ونموذج الموافقة المبدئية
└── archive/         ← نسخ قديمة/مستبدلة (للرجوع فقط)
```

---

## 🖥️ التطبيقات الأربعة

| الملف | لمن؟ | بيانات الدخول التجريبية |
|---|---|---|
| `glowspot-customer.html` | العميلة | تسجيل مفتوح — أنشئي حساباً بأي بيانات |
| `glowspot-dashboard.html` | صاحبة المركز | `glowbeauty` / `center123` |
| `glowspot-staff.html` | الخبيرة | `0920000001` / `expert123` |
| `glowspot-admin.html` | إدارة GlowSpot | `glowspot2026` |

**حسابات إضافية:**
- المراكز: `royalbeauty` / `center123` — `lunaspa` / `center123`
- الخبيرات (كلمة المرور للجميع `expert123`): 0920000002 مايا (مكياج)، 0920000003 نورا (أظافر)، 0920000007 آية (حنة)، 0920000004 لينا (شعر)، 0920000005 هدى (عناية)، 0920000006 أمل (سبا)، 0920000008 سلمى (حجامة)

⚠️ هذي بيانات تجريبية للعرض فقط، وليست نظام حماية حقيقي.

---

## 🗂️ نموذج البيانات

- **centers**: id, name, city, location, about, verified, rating, status, departments[], username, password, paymentMethods{}, homeService, views
- **experts**: id, centerId, department, name, specialty, rating, available, phone, password, servicePrices{}, serviceDurations{}, workingHours{}, leaveRequests[], clientNotes{}
- **bookings**: id, centerId, centerName, department, service, expertId, expertName, customerId, customerName, phone, date, time, duration, price, status, serviceLocation, homeAddress, declineReason, alternatives[]
- **customers**: id, name, phone, password, favorites[], favoriteExperts[]
- **packages**: id, centerId, name, items, price
- **reviews**: id, bookingId, centerId, expertId, customerId, customerName, rating, comment, createdAt

**الأقسام الثمانية:** شعر · مكياج · أظافر · حنة · سبا · حمام بخار · عناية وجمال · حجامة

---

## 🔄 دورة حياة الحجز

```
pending → confirmed → in_service → completed → (تقييم)
     ↘ declined (بسبب + بدائل مقترحة)
     ↘ cancelled
     ↘ no_show
```

---

## ✅ الميزات المنفّذة

**تطبيق العميلة:** حسابات · استكشاف وبحث · حجز سريع · حجز بثلاث طرق (عام / خبيرة محددة / باقة) · مفضلة للمراكز والخبيرات · مواعيد مع تذكير قبل 24 ساعة · تقييم بالنجوم والتعليق · صفحة كل الباقات · خدمة منزلية

**لوحة المركز:** تعديل بيانات المركز · تفعيل الأقسام · طرق الدفع لكل خدمة · تفعيل الخدمة المنزلية · إدارة الفريق · الباقات · متابعة الحجوزات · الموافقة على الإجازات

**لوحة الخبيرة:** قبول/رفض الطلبات بسبب مع اقتراح بدائل · تقويم يومي وأسبوعي · تحديد أسعار ومدد الخدمات · ساعات العمل وطلبات الإجازة · الإشعارات · التقييمات · ملاحظات العميلات

**لوحة الإدارة:** إنشاء المراكز بحساباتها · قبول/رفض/تعطيل · المستخدمات · كل الحجوزات · التقييمات · التحليلات والإيرادات

**منطق الجدولة:** المواعيد تُقسَّم حسب مدة الخدمة الفعلية (تصفيف 45 دقيقة ← 10:00، 10:45، 11:30...)، ومنع التعارض يحسب تداخل الفترات لا تطابق الأوقات فقط.

---

## ❌ غير منفّذ بعد

- الدفع الإلكتروني والمحفظة
- الخريطة التفاعلية
- الصور الحقيقية للمراكز (مستبدلة بتدرجات لونية)
- الإشعارات خارج التطبيق (Push Notifications)
- نظام تتبّع العمولات

---

## ⚙️ ملاحظات تقنية

- كل تطبيق ملف HTML واحد مستقل، يُفتح مباشرة بالمتصفح دون خادم
- البيانات تُحفظ عبر `window.storage` وتتشارك بين التطبيقات الأربعة
- هذي **نماذج تفاعلية للعرض والتجربة**، وليست جاهزة للإنتاج: لا يوجد تشفير لكلمات المرور، ولا خادم خلفي، ولا تحقق أمني حقيقي

**للانتقال لتطبيق حقيقي:** React Native عبر Expo للواجهة + Firebase للخلفية (Authentication + Firestore + Cloud Messaging).

---

## 📄 المستندات

- **GlowSpot-Catalog.pdf** — كتالوج شراكة من 14 صفحة لعرضه على أصحاب المراكز
- **GlowSpot-Preliminary-Approval-Form.pdf** — نموذج موافقة مبدئية للطباعة والتعبئة

⚠️ صفحة التواصل في الكتالوج ونموذج QR ما زالت فارغة — تحتاج بياناتك الحقيقية.
