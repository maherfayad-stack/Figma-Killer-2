import { useState } from 'react'
import {
  Navbar,
  Cell,
  SystemBanner,
  Separator,
  Button,
} from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import styles from './Page.module.css'

export default function Page() {
  const [notifications, setNotifications] = useState(true)
  const [darkMode, setDarkMode] = useState(false)

  return (
    <main className={styles.page}>
      <Navbar
        toolbar={{
          variant: 'default',
          title: 'Account',
          onBack: () => {},
        }}
      />

      <section className={styles.section}>
        <SystemBanner
          type="success"
          title="Profile verified"
          description="Your identity has been confirmed and you're ready to book."
        />
      </section>

      <section className={styles.group}>
        <h2 className={styles.heading}>Preferences</h2>
        <div className={styles.card}>
          <Cell
            visual="icon"
            label="Push notifications"
            trailing="toggle"
            toggleChecked={notifications}
            onToggleChange={() => setNotifications((v) => !v)}
            showSeparator
          />
          <Cell
            visual="icon"
            label="Dark appearance"
            trailing="toggle"
            toggleChecked={darkMode}
            onToggleChange={() => setDarkMode((v) => !v)}
            showSeparator
          />
          <Cell
            visual="icon"
            label="Language"
            value="English"
            trailing="chevron"
            showSeparator
          />
          <Cell
            visual="icon"
            label="Currency"
            value="SAR"
            trailing="chevron"
          />
        </div>
      </section>

      <section className={styles.group}>
        <h2 className={styles.heading}>Support</h2>
        <div className={styles.card}>
          <Cell visual="icon" label="Help centre" trailing="chevron" showSeparator />
          <Cell visual="icon" label="Contact us" trailing="chevron" showSeparator />
          <Cell visual="icon" label="Terms & privacy" trailing="chevron" />
        </div>
      </section>

      <Separator type="section separator" />

      <section className={styles.section}>
        <Button variant="destructive" label="Sign out" />
      </section>
    </main>
  )
}
