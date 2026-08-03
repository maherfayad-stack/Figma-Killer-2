import styles from './Onboarding.module.css'
import { Button } from '@alm-design/design-system'

export default function Onboarding() {
  return (
    <main className={styles.page} style={{ display: "flex", flexDirection: "column", gap: "var(--space)", width: "100%", maxWidth: "393px", marginInline: "auto", padding: "var(--space)", background: "var(--background-base-default)", minHeight: "800px", boxSizing: "border-box", fontFamily: "Open Sans, system-ui, sans-serif" }}>
      <div role="img" aria-label="onboarding hero" style={{ width: "100%", height: "280px", borderRadius: "var(--rounded-lg)", background: "var(--background-base-subtle)" }} />
      <h1 style={{ fontSize: "var(--type-display-size)", fontWeight: "var(--type-display-weight)", lineHeight: "var(--type-display-lh)", letterSpacing: "var(--type-display-ls)", color: "var(--text-base-default)", margin: "0" }}>Complete your setup. Don't miss out on:</h1>
      <ul style={{ listStyle: "none", padding: "0", margin: "0", display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>💬</span>
          <span>Unique rates via WhatsApp, email, and SMS!</span>
        </li>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>📉</span>
          <span>Price drops before they are gone</span>
        </li>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>⚡</span>
          <span>Flash sales</span>
        </li>
        <li style={{ display: "flex", alignItems: "center", gap: "var(--space)" }}>
          <span aria-hidden="true" style={{ color: "var(--icon-secondary-default)", fontSize: "20px", width: "24px", textAlign: "center" }}>🏷</span>
          <span>Offers picked for you</span>
        </li>
      </ul>
      <Button variant="primary" label="Agree" />
      <a href="#" style={{ color: "var(--text-link-default)", textDecoration: "none", fontWeight: "600", textAlign: "center", padding: "var(--space)" }}>Maybe later</a>
      <p style={{ color: "var(--text-base-subtext)", fontSize: "var(--type-meta-size)", textAlign: "center", margin: "0" }}>By clicking Agree, I consent to receiving communications and acknowledge the privacy policy, and terms and conditions. You can opt-out anytime.</p>
    </main>
  )
}
