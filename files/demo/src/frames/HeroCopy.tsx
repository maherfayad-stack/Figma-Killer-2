import { Accolade, Slider } from 'design-system';

export default function Hero() {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center">
      <p className="max-w-xl text-lg text-slate-600">
        Search flights, hotels, and packages in one place — built for the modern traveler.
      </p>
      <h1 className="text-4xl font-bold text-slate-900 p-4">
        <Slider value={50} max={60} dir="rtl" />
        Plan your next trip effortlessly
      </h1>
      <button className="rounded-full bg-sky-600 px-6 py-3 font-semibold text-white">
        Start planning
      </button>
      <Accolade />
    </section>
  );
}
