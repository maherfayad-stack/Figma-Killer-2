import { Button } from '@alm-design/design-system'

export default function Catalog() {
  const items = ['A', 'B', 'C']

  return (
    <div>
      <p>Catalog</p>
      <Button label="View catalog" variant="destructive" />
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  )
}
