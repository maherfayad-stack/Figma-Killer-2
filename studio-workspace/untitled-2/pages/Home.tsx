import { useState } from 'react'
import {
  Navbar,
  SegmentedControl,
  Cell,
  Button,
  MarketingCard,
  Separator,
} from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import styles from './Home.module.css'

export default function Home() {
  const [tab, setTab] = useState(0)

  return (
    <main className={styles.page}>
      <Navbar
        toolbar={{
          variant: 'default',
          title: 'Almosafer',
          subtitle: 'Where to next?',
        }}
      />

      <section className={styles.section}>
        <SegmentedControl
          items={['Flights', 'Stays', 'Cars']}
          value={tab}
          onChange={setTab}
        />

        <div className={styles.card}>
          <Cell
            visual="icon"
            label="From"
            value="Dubai (DXB)"
            trailing="chevron"
            showSeparator
          />
          <Cell
            visual="icon"
            label="To"
            value="Jeddah (JED)"
            trailing="chevron"
            showSeparator
          />
          <Cell
            visual="icon"
            label="Dates"
            value="11 – 28 Aug"
            trailing="chevron"
            showSeparator
          />
          <Cell
            visual="icon"
            label="Travellers & class"
            value="2 adults · Economy"
            trailing="chevron"
          />
        </div>

        <Button variant="primary" label="Search flights" />
      </section>

      <Separator type="section separator" />

      <section className={styles.section}>
        <h2 className={styles.heading}>Trending destinations</h2>
        <MarketingCard
          type="solid"
          title="Skip the taxi queue"
          subtitle="Book an airport transfer and arrive stress-free"
          imageSize="small"
          actionLabel="Book a transfer"
        />
      </section>
    </main>
  )
}
