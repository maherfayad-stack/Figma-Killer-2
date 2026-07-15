export function DynamicList({ items, isAdmin, label }: { items: string[]; isAdmin: boolean; label?: string }) {
  return (
    <div className="list">
      <ul>
        {items.map((item) => (
          <li key={item}>
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {isAdmin ? <button>Admin Action</button> : <span>Read only</span>}
      {label && <p>{label}</p>}
      <footer>Static footer</footer>
    </div>
  );
}
