export default function Hero() {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center">
      <h1 className="text-4xl font-bold text-slate-900">Plan your next trip effortlessly</h1>
      <p className="max-w-xl text-lg text-slate-600">
        Search flights, hotels, and packages in one place — built for the modern traveler.
      </p>
      <button className="rounded-full bg-sky-600 px-6 py-3 font-semibold text-white">
        Start planning
      </button>
    </section>
  );
}
