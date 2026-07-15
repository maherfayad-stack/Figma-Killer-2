export default function DynamicMapFrame({
  items,
  isAdmin,
}: {
  items: string[];
  isAdmin: boolean;
}) {
  return (
    <div className="list">
      <h2>Items</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {isAdmin ? <button>Admin Action</button> : <span>Read only</span>}
      <footer>Static footer</footer>
    </div>
  );
}
