// Arabic/RTL fixture frame (playbook §5.9: "RTL/Arabic first-class... test
// Arabic content in every phase's acceptance"). `dir="rtl"` + `lang="ar"`
// are set on the frame root; text content is real Arabic, not transliterated.
export default function Pricing() {
  return (
    <section
      dir="rtl"
      lang="ar"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50 px-6 text-center"
    >
      <h1 className="text-4xl font-bold text-slate-900">خطط الأسعار</h1>
      <p className="max-w-xl text-lg text-slate-600">
        اختر الباقة المناسبة لرحلتك القادمة واستمتع بأفضل العروض على الفنادق والطيران.
      </p>
      <div className="flex flex-col gap-3 rounded-2xl bg-white p-6 shadow-lg">
        <span className="text-sm text-slate-500">يبدأ من</span>
        <span className="text-3xl font-bold text-sky-600">499 ر.س</span>
        <button className="rounded-full bg-sky-600 px-6 py-3 font-semibold text-white">
          احجز الآن
        </button>
      </div>
    </section>
  );
}
