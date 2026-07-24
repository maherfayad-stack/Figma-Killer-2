import { Button } from '@alm-design/design-system'

export default function Catalog() {
  const items = ['A', 'B', 'C']

  return (
    <div style={{ display: "flex", flexDirection: "column",
        alignItems: "center",
        gap: "20px"
    }}>
      <p>{"asdasdasd"}</p>
      <Button label="View catalog" variant="primary" dir="rtl" size="small" />
      <ul tag="h1">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  )
}
