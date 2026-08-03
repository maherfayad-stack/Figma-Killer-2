import styles from './AddMobile.module.css'
import { TextInput, Button } from '@alm-design/design-system'

export default function AddMobile() {
  return (
    <main className={styles.page} style={{ display: "flex", flexDirection: "column", gap: "var(--space)", width: "100%", maxWidth: "375px", marginInline: "auto", padding: "var(--space)", background: "var(--background-base-default)", minHeight: "800px", boxSizing: "border-box", fontFamily: "Open Sans, system-ui, sans-serif" }}>
      <button type="button" aria-label="Back" style={{ width: "40px", height: "40px", border: "none", background: "transparent", color: "var(--icon-secondary-default)", fontSize: "24px", cursor: "pointer", padding: "0", alignSelf: "flex-start" }}>‹</button>
      <div role="img" aria-label="phone preview" style={{ width: "100%", height: "148px", borderRadius: "var(--rounded-lg)", background: "var(--background-base-subtle)" }} />
      <h1 style={{ fontSize: "var(--type-headline-size)", fontWeight: "var(--type-headline-weight)", lineHeight: "var(--type-headline-lh)", letterSpacing: "var(--type-headline-ls)", color: "var(--text-base-default)", margin: "0" }}>Add your mobile number</h1>
      <p style={{ color: "var(--text-base-subtext)", margin: "0", fontSize: "14px" }}>Sign in faster next time, and get Notified the moment something changes</p>
      <ul style={{ listStyle: "none", padding: "0", margin: "0", display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>✈</span>
          <span>Live flight updates</span>
        </li>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>🗓</span>
          <span>Boarding pass &amp; activity reminders</span>
        </li>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>🏷</span>
          <span>Flash sales</span>
        </li>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>⚡</span>
          <span>One-tap sign-in next time</span>
        </li>
      </ul>
      <div style={{ display: "flex", gap: "var(--space-sm)" }}>
        <TextInput label="Code" dropdown />
        <TextInput label="Mobile number" required />
      </div>
      <Button variant="primary" label="Verify Number" />
      <p style={{ color: "var(--text-base-subtext)", fontSize: "var(--type-caption-size)", textAlign: "center", margin: "0" }}>Updates by SMS or WhatsApp. No marketing spam.</p>
    </main>
  )
}
