export function Frame({ items }: { items: string[] }) {
  return (
    <div>
      <header>h</header>
      <em></em>
      {items.map((i) => (
        <span key={i}>{i}</span>
      ))}
      <footer>f</footer>
    </div>
  );
}
