export function Frame({ items }: { items: string[] }) {
  return (
    <div>
      {items.map((i) => (
        <span key={i}>{i}</span>
      ))}
      <footer>f</footer>
      <header>h</header>
    </div>
  );
}
