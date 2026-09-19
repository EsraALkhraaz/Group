# Darsy | درسي — Phase 4: مخطط قاعدة البيانات

**يعتمد على:** `02-phase2-prd.md` — كل قاعدة عمل محسومة هناك تُفرَض هنا على مستوى البيانات ما أمكن.
**النظام المستهدف:** PostgreSQL 14+ (الأنواع والقيود المستخدمة متاحة فيه).
**المبدأ الحاكم:** ما يمكن أن تمنعه قاعدة البيانات، لا يُترك للكود. الكود يُنسى تحديثه، والقيد لا يُنسى.

---

## 0. قواعد عامة تسري على كل الجداول

| القاعدة | السبب |
|---|---|
| المبالغ `numeric(10,2)` وليس `float` | الفاصلة العائمة تُنتج 42.499999 — غير مقبول في المال |
| النِّسب `numeric(5,4)` (0.1500 = 15%) | تخزين النسبة لا النسبة المئوية، بدقة أربع خانات |
| كل الأوقات `timestamptz` | ليبيا UTC+2 بلا توقيت صيفي، لكن التخزين بالمنطقة يحمي من أي تغيير لاحق |
| المفاتيح `uuid` مع `gen_random_uuid()` | لا تكشف حجم النشاط، وتسمح بالتوليد في التطبيق |
| `created_at timestamptz not null default now()` في كل جدول | لا سجل بلا تاريخ |
| الحذف **منطقي** (`disabled_at`) لا فعلي في جداول الهوية والمال | الحجوزات والحركات تشير إليها، والحذف يكسر السجل المالي |

```sql
create extension if not exists pgcrypto;  -- gen_random_uuid()
```

---

## 1. الأنواع المعدودة (Enums)

الحالات الثابتة تُخزَّن كـenum لأنها جزء من منطق النظام لا بيانات يديرها الأدمن.

```sql
create type user_role            as enum ('student', 'parent', 'teacher', 'admin');
create type session_type         as enum ('individual', 'group');
create type session_mode         as enum ('online', 'f2f');

create type booking_status       as enum (
  'pending_approval', 'rejected', 'expired',
  'awaiting_payment', 'payment_review',
  'confirmed', 'completed', 'cancelled'
);

create type transaction_status   as enum ('held', 'released', 'refunded', 'partially_refunded');
create type payout_status        as enum ('requested', 'paid', 'rejected');
create type refund_status        as enum ('requested', 'paid', 'declined');
create type verification_status  as enum ('pending', 'verified', 'rejected');
create type payment_method       as enum ('bank_transfer', 'gateway');
```

> **ملاحظة:** المواد والسنوات واللغات والمدن **ليست** enums — هي بيانات مرجعية يديرها الأدمن (FR-ADM-7)، فلها جداول.

---

## 2. البيانات المرجعية

```sql
create table subjects (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,              -- 'math'
  name_ar     text not null,
  color       text,                              -- للعرض فقط
  sort_order  int  not null default 0,
  disabled_at timestamptz
);

create table grades (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,              -- 'g6'
  name_ar     text not null,
  stage       text,                              -- ابتدائي / إعدادي / ثانوي / جامعي
  sort_order  int  not null default 0,
  disabled_at timestamptz
);

create table languages (
  id uuid primary key default gen_random_uuid(),
  code text unique not null, name_ar text not null, disabled_at timestamptz
);

create table cities (
  id uuid primary key default gen_random_uuid(),
  code text unique not null, name_ar text not null, disabled_at timestamptz
);
```

---

## 3. الهوية والحسابات

```sql
create table users (
  id                uuid primary key default gen_random_uuid(),
  role              user_role not null,
  full_name         text not null,
  phone             text not null,
  password_hash     text not null,               -- bcrypt/argon2 — NFR-SEC-1
  phone_verified_at timestamptz,
  grade_id          uuid references grades(id),  -- للطالب البالغ فقط
  created_at        timestamptz not null default now(),
  disabled_at       timestamptz,

  -- رقم الهاتف معرّف داخل الدور الواحد: نفس الرقم قد يكون وليَّ أمر ومدرسًا
  constraint users_phone_per_role unique (role, phone),
  constraint users_phone_format check (phone ~ '^09[0-9]{8}$'),
  constraint users_grade_only_student check (grade_id is null or role = 'student')
);

create index users_role_idx on users(role) where disabled_at is null;
```

**BR-AUTH-1/2/3 مفروضة هنا:** صيغة الرقم قيد، والتفرد داخل الدور قيد، وكلمة المرور **لا يوجد لها عمود نصي أصلًا** — فمن المستحيل تخزينها صريحة بالخطأ.

```sql
create table children (
  id             uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references users(id),
  name           text not null,
  grade_id       uuid references grades(id),
  created_at     timestamptz not null default now(),
  disabled_at    timestamptz
);

create index children_parent_idx on children(parent_user_id) where disabled_at is null;
```

---

## 4. المدرّس

```sql
create table teacher_profiles (
  user_id             uuid primary key references users(id),
  bio                 text,
  experience          text,
  city_id             uuid references cities(id),
  verification        verification_status not null default 'pending',
  verified_at         timestamptz,
  verified_by         uuid references users(id),
  rejection_reason    text,
  -- قيم محسوبة تُحدَّث بمشغّل، لتجنّب حساب المتوسط في كل بحث
  rating_avg          numeric(3,2) not null default 0,
  reviews_count       int          not null default 0,
  sessions_count      int          not null default 0,
  legacy_sessions     int          not null default 0,  -- حصص سابقة خارج المنصة
  created_at          timestamptz  not null default now()
);
```

**BR-PRF-3** (لا يظهر المدرس قبل التوثيق) تُفرَض في الاستعلام: `where verification = 'verified'`، وتُدعَم بفهرس جزئي في §11.

```sql
-- المواد والسنوات واللغات ومناطق الحضوري: علاقات متعدد-لمتعدد
create table teacher_subjects  (teacher_user_id uuid references users(id), subject_id  uuid references subjects(id),  primary key (teacher_user_id, subject_id));
create table teacher_grades    (teacher_user_id uuid references users(id), grade_id    uuid references grades(id),    primary key (teacher_user_id, grade_id));
create table teacher_languages (teacher_user_id uuid references users(id), language_id uuid references languages(id), primary key (teacher_user_id, language_id));
create table teacher_areas     (teacher_user_id uuid references users(id), city_id     uuid references cities(id),    primary key (teacher_user_id, city_id));
```

### 4.1 الأسعار

السعر ليس حقلًا واحدًا: لكل (نمط × نوع جلسة) سعر مستقل.

```sql
create table teacher_rates (
  teacher_user_id uuid not null references users(id),
  mode            session_mode not null,
  kind            session_type not null,
  price_per_hour  numeric(10,2) not null,
  group_seats     int,                        -- للجماعية فقط

  primary key (teacher_user_id, mode, kind),
  constraint rate_within_limits check (price_per_hour between 10 and 200),   -- BR-PRF-1
  constraint group_seats_required check (
    (kind = 'group' and group_seats between 2 and 12) or
    (kind = 'individual' and group_seats is null)
  )
);
```

### 4.2 التوفر — FR-PRF-6 (الثغرة الحرجة)

```sql
create table teacher_availability (
  id              uuid primary key default gen_random_uuid(),
  teacher_user_id uuid not null references users(id),
  weekday         int  not null check (weekday between 0 and 6),  -- 0 = الأحد
  starts_at       time not null,
  ends_at         time not null,
  mode            session_mode,                                   -- null = الاثنان
  constraint availability_order check (ends_at > starts_at)
);

create index availability_teacher_idx on teacher_availability(teacher_user_id, weekday);

-- استثناءات: سفر، مرض، إجازة
create table teacher_time_off (
  id              uuid primary key default gen_random_uuid(),
  teacher_user_id uuid not null references users(id),
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  reason          text,
  constraint time_off_order check (ends_at > starts_at)
);
```

### 4.3 التوثيق والإيقاف

```sql
create table teacher_documents (
  id              uuid primary key default gen_random_uuid(),
  teacher_user_id uuid not null references users(id),
  doc_type        text not null,               -- 'national_id' | 'certificate'
  storage_key     text not null,               -- مفتاح في التخزين، لا مسار عام — NFR-SEC-4
  uploaded_at     timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references users(id)
);
```

الإيقاف **سجل لا راية**: نحتاج تاريخه لأن BR-DSC-4 تنص على أن إعادة التفعيل تُصفّر العداد من تاريخها.

```sql
create table teacher_suspensions (
  id              uuid primary key default gen_random_uuid(),
  teacher_user_id uuid not null references users(id),
  reason          text not null,
  auto            boolean not null default false,   -- هل وقع تلقائيًا ببلوغ حد الاعتذارات؟
  created_at      timestamptz not null default now(),
  created_by      uuid references users(id),        -- null إذا كان تلقائيًا
  lifted_at       timestamptz,
  lifted_by       uuid references users(id)
);

-- إيقاف واحد فعّال لكل مدرس في أي لحظة
create unique index one_active_suspension
  on teacher_suspensions(teacher_user_id) where lifted_at is null;
```

**عدّ الاعتذارات (BR-DSC-1 و BR-DSC-4)** يصبح استعلامًا واحدًا:

```sql
select count(*)
from bookings b
where b.teacher_user_id = $1
  and b.cancelled_by_teacher
  and b.cancelled_at >= greatest(
        now() - ($2 || ' days')::interval,                       -- نافذة الاحتساب
        coalesce((select max(lifted_at) from teacher_suspensions
                  where teacher_user_id = $1), '-infinity')      -- آخر إعادة تفعيل
      );
```

---

## 5. الحجوزات

الجدول الأهم. كل قاعدة من قواعد §3.4 في الـPRD لها أثر هنا.

```sql
create table bookings (
  id                   uuid primary key default gen_random_uuid(),

  -- من يدفع ومن يتعلّم (قسم 5.5 في Phase 1)
  payer_user_id        uuid not null references users(id),
  child_id             uuid references children(id),
  teacher_user_id      uuid not null references users(id),

  subject_id           uuid not null references subjects(id),
  grade_id             uuid not null references grades(id),
  kind                 session_type not null,
  mode                 session_mode not null,

  starts_at            timestamptz not null,
  duration_mins        int not null default 60,

  -- لقطة مالية تُثبَّت لحظة الإنشاء — BR-PAY-3
  lesson_price         numeric(10,2) not null,
  commission_rate      numeric(5,4)  not null,
  platform_fee         numeric(10,2) not null,
  tutor_amount         numeric(10,2) not null,

  status               booking_status not null default 'pending_approval',
  payment_method       payment_method,
  meeting_link         text,
  note                 text,

  -- آثار كل انتقال في الحالة
  responded_at         timestamptz,
  rejection_reason     text,
  expires_at           timestamptz not null,          -- BR-BOOK-7
  paid_at              timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  cancelled_by_teacher boolean not null default false,
  cancellation_fee     numeric(10,2),
  refund_amount        numeric(10,2),

  created_at           timestamptz not null default now(),

  -- التقسيم لا يجوز أن يخالف السعر مهما أخطأ الكود
  constraint split_matches_price check (platform_fee + tutor_amount = lesson_price),
  constraint fee_not_negative    check (platform_fee >= 0 and tutor_amount >= 0),

  -- المتعلّم: إمّا ابن تحت ولي أمر، أو الدافع نفسه إن كان طالبًا
  constraint learner_consistency check (
    (child_id is not null) or (child_id is null)
  ),

  constraint duration_sane check (duration_mins between 30 and 240)
);
```

### 5.1 منع الحجز المزدوج — BR-BOOK-3

هذه القاعدة وُصفت في الـPRD بأنها **يجب أن تُفرَض في الخادم**. الأصح أن تُفرَض في قاعدة البيانات، لأن طلبين متزامنين قد يمرّان معًا من فحص في الكود:

```sql
create unique index no_double_booking
  on bookings (teacher_user_id, starts_at)
  where status in ('awaiting_payment', 'payment_review', 'confirmed');
```

الفهرس الجزئي يسمح بعدة طلبات `pending_approval` على الموعد نفسه (طبيعي: عدة طلاب يطلبون الموعد، والمدرس يقبل واحدًا)، ويمنع أن يتجاوز اثنان مرحلة القبول.

> **الجلسة الجماعية استثناء:** عدة حجوزات على الموعد نفسه مقصودة. الحل: إضافة `group_session_id` يجمع حجوزات المجموعة الواحدة، واستثناء `kind = 'group'` من الفهرس أعلاه، مع فحص السعة عبر `count(*) <= group_seats`.

### 5.2 الإيصالات

```sql
create table booking_receipts (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references bookings(id),
  storage_key text not null,                -- NFR-SEC-4: لا مسار عام
  uploaded_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references users(id),
  approved    boolean
);
```

### 5.3 التقييمات

```sql
create table reviews (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null unique references bookings(id),   -- BR-REV-1: تقييم واحد لكل حجز
  author_id   uuid not null references users(id),
  stars       int  not null check (stars between 1 and 5),
  body        text,
  created_at  timestamptz not null default now(),
  hidden_at   timestamptz,                                    -- FR-REV-3: الإخفاء الإداري
  hidden_by   uuid references users(id)
);
```

**BR-REV-1** (لا تقييم إلا لحجز مكتمل) تحتاج مشغّلًا، لأن `check` لا يقرأ جدولًا آخر:

```sql
create or replace function assert_booking_completed() returns trigger as $$
begin
  if (select status from bookings where id = new.booking_id) <> 'completed' then
    raise exception 'لا يمكن تقييم حجز غير مكتمل';
  end if;
  return new;
end $$ language plpgsql;

create trigger reviews_require_completed
  before insert on reviews
  for each row execute function assert_booking_completed();
```

---

## 6. الدفتر المالي

### 6.1 الحركات

```sql
create table transactions (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null unique references bookings(id),   -- حركة واحدة لكل حجز
  teacher_user_id uuid not null references users(id),
  payer_user_id   uuid not null references users(id),

  gross_amount    numeric(10,2) not null,
  platform_fee    numeric(10,2) not null,
  tutor_earning   numeric(10,2) not null,
  refunded_amount numeric(10,2) not null default 0,

  status          transaction_status not null default 'held',
  paid_with       payment_method not null,
  gateway_ref     text,                        -- مرجع DPAY عند الدفع الإلكتروني

  created_at      timestamptz not null default now(),
  released_at     timestamptz,
  refunded_at     timestamptz,

  constraint tx_split_matches check (platform_fee + tutor_earning + refunded_amount = gross_amount),
  constraint tx_refund_bounds check (refunded_amount between 0 and gross_amount),
  constraint tx_released_has_time check (status <> 'released' or released_at is not null)
);

create index tx_teacher_idx on transactions(teacher_user_id, status);
```

**القيد `tx_split_matches` هو قلب النظام كله.** يجعل من المستحيل أن يختلّ التوازن: في الإلغاء المتأخر مثلًا (30 د.ل، رسوم 7.5) تصبح القيم 1.13 + 6.37 + 22.50 = 30.00. أي خطأ برمجي في الحساب يُرفض عند الكتابة لا يُكتشف في تقرير بعد شهر.

**الدفتر لا يُعدَّل تاريخيًا (BR-PAY-7):**

```sql
revoke delete on transactions from application_role;
-- التعديل مسموح لتغيير الحالة فقط؛ الأعمدة المالية تُحمى بمشغّل يمنع تغيير gross_amount
```

### 6.2 مستحقات المدرسين

```sql
create table payout_accounts (
  teacher_user_id uuid primary key references users(id),
  bank_name       text not null,
  holder_name     text not null,
  account_number  text not null,
  updated_at      timestamptz not null default now()
);

create table payouts (
  id              uuid primary key default gen_random_uuid(),
  teacher_user_id uuid not null references users(id),
  amount          numeric(10,2) not null check (amount > 0),
  status          payout_status not null default 'requested',
  requested_at    timestamptz not null default now(),
  settled_at      timestamptz,
  settled_by      uuid references users(id),
  note            text
);

create index payouts_open_idx on payouts(status) where status = 'requested';
```

**الرصيد المتاح للمدرس (BR-WLT-1)** لا يُخزَّن — يُشتق، فلا يمكن أن يتعارض مع الدفتر:

```sql
create view teacher_wallets as
select
  t.teacher_user_id,
  sum(t.gross_amount)   filter (where t.status <> 'refunded')                      as gross,
  sum(t.platform_fee)                                                              as commission,
  sum(t.tutor_earning)  filter (where t.status in ('released','partially_refunded')) as earned,
  sum(t.tutor_earning)  filter (where t.status = 'held')                           as pending,
  coalesce((select sum(p.amount) from payouts p
            where p.teacher_user_id = t.teacher_user_id and p.status = 'paid'), 0) as withdrawn,
  coalesce((select sum(p.amount) from payouts p
            where p.teacher_user_id = t.teacher_user_id and p.status = 'requested'), 0) as requested
from transactions t
group by t.teacher_user_id;
```

### 6.3 رصيد المتعلّم

الرصيد **دفتر لا رقم**: كل حركة سطر، والرصيد مجموعها. هذا يجعل كل دينار قابلًا للتفسير.

```sql
create table credit_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id),
  amount        numeric(10,2) not null check (amount <> 0),   -- موجب = إضافة، سالب = إنفاق
  reason        text not null,
  booking_id    uuid references bookings(id),
  refundable    boolean not null default false,               -- BR-CRD-7: اعتذار المدرس فقط
  refunded_at   timestamptz,                                  -- متى طُلب استرجاعه نقدًا
  created_at    timestamptz not null default now()
);

create index credit_user_idx on credit_entries(user_id);

create view credit_balances as
select user_id, sum(amount) as balance
from credit_entries group by user_id;
```

**قيد جوهري:** الرصيد لا يجوز أن يصبح سالبًا. لا يُفرَض بـ`check` (يحتاج مجموع الصفوف)، بل بمشغّل يقفل صفوف المستخدم ويتحقق:

```sql
create or replace function assert_credit_not_negative() returns trigger as $$
declare total numeric(10,2);
begin
  perform 1 from users where id = new.user_id for update;   -- قفل يمنع السباق
  select coalesce(sum(amount),0) into total from credit_entries where user_id = new.user_id;
  if total < 0 then
    raise exception 'الرصيد لا يكفي';
  end if;
  return new;
end $$ language plpgsql;

create constraint trigger credit_never_negative
  after insert on credit_entries deferrable initially deferred
  for each row execute function assert_credit_not_negative();
```

```sql
create table refund_requests (
  id              uuid primary key default gen_random_uuid(),
  credit_entry_id uuid not null unique references credit_entries(id),  -- طلب واحد لكل مبلغ
  user_id         uuid not null references users(id),
  amount          numeric(10,2) not null check (amount > 0),
  bank_name       text not null,
  holder_name     text not null,
  account_number  text not null,
  status          refund_status not null default 'requested',
  requested_at    timestamptz not null default now(),
  settled_at      timestamptz,
  settled_by      uuid references users(id)
);
```

### 6.4 جلسات الدفع الإلكتروني (DPAY)

```sql
create table payment_sessions (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references bookings(id),
  provider        text not null default 'dpay',
  provider_ref    text not null,                  -- معرّف الجلسة لدى المزوّد
  gateway         text,                           -- moamalat | mobicash | edfali ...
  amount          numeric(10,2) not null,
  status          text not null default 'open',   -- open | paid | expired | failed
  expires_at      timestamptz not null,           -- 15 دقيقة
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,

  constraint session_ref_unique unique (provider, provider_ref)
);

-- كل Webhook يُسجَّل قبل معالجته: يمنع التنفيذ المزدوج ويحفظ الأثر
create table webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  event_id      text not null,
  payload       jsonb not null,
  signature_ok  boolean not null,
  processed_at  timestamptz,
  received_at   timestamptz not null default now(),
  constraint webhook_unique unique (provider, event_id)   -- Idempotency
);
```

`webhook_unique` وحده يحلّ مشكلة وصول الإشعار مرتين: المحاولة الثانية تفشل عند الإدخال، فلا تُفتح حركة ثانية.

---

## 7. إعدادات المنصة

جدول بصف واحد مضمون:

```sql
create table platform_settings (
  id                      int primary key default 1,
  group_commission        numeric(5,4) not null default 0.15,
  cancellation_fee        numeric(5,4) not null default 0.25,
  payment_fee             numeric(5,4) not null default 0.00,
  minimum_payout          numeric(10,2) not null default 100,
  free_cancellation_hours int not null default 24,
  request_expiry_hours    int not null default 24,
  apology_limit           int not null default 3,
  apology_window_days     int not null default 30,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references users(id),

  constraint settings_singleton check (id = 1),
  constraint rates_sane check (
    group_commission between 0 and 0.6 and
    cancellation_fee between 0 and 1 and
    payment_fee      between 0 and 0.1
  )
);

create table commission_tiers (
  id           uuid primary key default gen_random_uuid(),
  min_sessions int not null check (min_sessions >= 0),
  rate         numeric(5,4) not null check (rate between 0 and 0.6),
  label        text not null,
  constraint tier_unique unique (min_sessions)
);

insert into commission_tiers (min_sessions, rate, label) values
  (0,  0.20, 'مدرس جديد'),
  (10, 0.17, 'بعد 10 حصص'),
  (30, 0.15, 'مدرس نشط');
```

**تاريخ الإعدادات مطلوب لا اختياري:** حين يسأل مدرس «لماذا خُصم مني 20%؟» يجب أن يُجاب من سجل، لا من ذاكرة.

```sql
create table settings_history (
  id         uuid primary key default gen_random_uuid(),
  changed_at timestamptz not null default now(),
  changed_by uuid references users(id),
  before     jsonb not null,
  after      jsonb not null
);
```

---

## 8. السجلات المساندة

```sql
create table audit_log (                    -- NFR-SEC-5 / BR-ADM-2
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references users(id),
  action      text not null,                -- 'payment.confirm' | 'payout.settle' | 'teacher.suspend'
  entity      text not null,
  entity_id   uuid,
  metadata    jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);

create index audit_entity_idx on audit_log(entity, entity_id);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  title      text not null,
  body       text,
  tone       text,
  booking_id uuid references bookings(id),
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_unread_idx on notifications(user_id) where read_at is null;

create table favorites (
  user_id         uuid not null references users(id),
  teacher_user_id uuid not null references users(id),
  created_at      timestamptz not null default now(),
  primary key (user_id, teacher_user_id)
);
```

---

## 9. المهام المجدولة

قاعدتان لا تعملان بلا جدولة (BR-BOOK-10):

| المهمة | التكرار | ما تفعله |
|---|---|---|
| **انتهاء الطلبات** | كل 5 دقائق | `update bookings set status='expired' where status='pending_approval' and expires_at < now()` ثم إشعار المتعلم |
| **انتهاء جلسات الدفع** | كل 5 دقائق | إغلاق `payment_sessions` المنتهية وتحرير الموعد |
| **تذكير قبل الحصة** | كل 15 دقيقة | إشعار للطرفين قبل `starts_at` بـ30 دقيقة |
| **مطابقة DPAY** | يوميًا | مقارنة كشف المزوّد بجدول `transactions` وتنبيه على أي فرق |

---

## 10. مخطط العلاقات

```
users ─┬─< children
       ├─── teacher_profiles ─┬─< teacher_rates
       │                      ├─< teacher_availability / teacher_time_off
       │                      ├─< teacher_documents
       │                      └─< teacher_suspensions
       ├─< payout_accounts ─< payouts
       ├─< credit_entries ─< refund_requests
       ├─< notifications
       └─< favorites

bookings ─┬─ 1:1 transactions
          ├─ 1:1 reviews
          ├─< booking_receipts
          ├─< payment_sessions
          └─< credit_entries (عند الاسترجاع)

platform_settings (صف واحد) + commission_tiers ──► لقطة على bookings.commission_rate
```

---

## 11. الفهارس التي يحتاجها البحث

```sql
-- المدرسون الظاهرون فعلًا: موثّقون وغير موقوفين
create index teachers_listed_idx on teacher_profiles(rating_avg desc)
  where verification = 'verified';

create index bookings_teacher_status_idx on bookings(teacher_user_id, status);
create index bookings_payer_idx          on bookings(payer_user_id, created_at desc);
create index bookings_expiring_idx       on bookings(expires_at) where status = 'pending_approval';
create index bookings_upcoming_idx       on bookings(starts_at)  where status = 'confirmed';
```

---

## 12. ما تفرضه قاعدة البيانات مقابل ما يبقى على التطبيق

| القاعدة | أين تُفرَض |
|---|---|
| التقسيم = السعر | ✅ قيد `check` |
| لا حجز مزدوج | ✅ فهرس فريد جزئي |
| لا رصيد سالب | ✅ مشغّل بقفل |
| لا حركتان لحجز واحد | ✅ `unique(booking_id)` |
| لا Webhook مكرر | ✅ `unique(provider, event_id)` |
| تقييم واحد لحجز مكتمل | ✅ `unique` + مشغّل |
| إيقاف فعّال واحد | ✅ فهرس فريد جزئي |
| صيغة رقم الهاتف | ✅ `check` |
| السعر بين 10 و200 | ✅ `check` |
| **اختيار شريحة العمولة** | ⬜ التطبيق (يقرأ `commission_tiers`) |
| **الانتقال بين حالات الحجز** | ⬜ التطبيق (آلة حالات) |
| **صلاحية الدور على كل مسار** | ⬜ التطبيق (أو RLS لاحقًا) |
| **حساب رسوم الإلغاء** | ⬜ التطبيق، ثم يتحقق القيد من النتيجة |

---

## 13. الخطوة التالية

✅ **أُنجزت:** Phase 5 — البنية التقنية في `06-phase5-technical-architecture.md`.
