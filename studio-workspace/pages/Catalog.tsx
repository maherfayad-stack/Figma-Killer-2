import { Button } from '@alm-design/design-system'

export default function Catalog() {
  const items = ['A', 'B', 'C']

  return (
    <div>
      <p>{"Catalog"}</p>
      <Button label="View catalog" variant="primary-inverted" dir="rtl" size="small" />
      <ul tag="h5">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  )
}
