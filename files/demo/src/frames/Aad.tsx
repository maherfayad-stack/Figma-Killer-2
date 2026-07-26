import { Accolade, Badge } from 'design-system';

export default function Aad() {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">Aad</h1>
      <Accolade />
      <Badge />
    </section>
  );
}
