import styles from './SmsEmail.module.css'

export default function SmsEmail() {
  return (
    <main className={styles.page} style={{ display: "flex", flexDirection: "column", gap: "var(--space)", width: "100%", maxWidth: "375px", marginInline: "auto", padding: "var(--space)", background: "var(--background-base-default)", minHeight: "800px", boxSizing: "border-box", fontFamily: "Open Sans, system-ui, sans-serif" }}>
      <button type="button" aria-label="Back" style={{ width: "40px", height: "40px", border: "none", background: "transparent", color: "var(--icon-secondary-default)", fontSize: "24px", cursor: "pointer", padding: "0", alignSelf: "flex-start" }}>‹</button>
      <h1 style={{ fontSize: "var(--type-headline-size)", fontWeight: "var(--type-headline-weight)", lineHeight: "var(--type-headline-lh)", letterSpacing: "var(--type-headline-ls)", color: "var(--text-base-default)", margin: "0" }}>Enter Verification Code</h1>
      <p style={{ color: "var(--text-base-subtext)", margin: "0", fontSize: "14px" }}>Enter the 6-digit code sent via:</p>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
        <span style={{ color: "var(--icon-secondary-default)", fontSize: "20px" }}>✉</span>
        <span>Email at </span>
        <strong>emal@domain.com</strong>
      </div>
      <div style={{ display: "flex", gap: "var(--space-sm)" }}>
        <input maxLength={1} inputMode="numeric" style={{ width: "50px", height: "50px", borderRadius: "var(--rounded-xs)", border: "1px solid var(--border-base-default)", textAlign: "center", fontSize: "20px" }} />
        <input maxLength={1} inputMode="numeric" style={{ width: "50px", height: "50px", borderRadius: "var(--rounded-xs)", border: "1px solid var(--border-base-default)", textAlign: "center", fontSize: "20px" }} />
        <input maxLength={1} inputMode="numeric" style={{ width: "50px", height: "50px", borderRadius: "var(--rounded-xs)", border: "1px solid var(--border-base-default)", textAlign: "center", fontSize: "20px" }} />
        <input maxLength={1} inputMode="numeric" style={{ width: "50px", height: "50px", borderRadius: "var(--rounded-xs)", border: "1px solid var(--border-base-default)", textAlign: "center", fontSize: "20px" }} />
        <input maxLength={1} inputMode="numeric" style={{ width: "50px", height: "50px", borderRadius: "var(--rounded-xs)", border: "1px solid var(--border-base-default)", textAlign: "center", fontSize: "20px" }} />
        <input maxLength={1} inputMode="numeric" style={{ width: "50px", height: "50px", borderRadius: "var(--rounded-xs)", border: "1px solid var(--border-base-default)", textAlign: "center", fontSize: "20px" }} />
      </div>
      <p style={{ color: "var(--text-base-subtext)", fontSize: "var(--type-caption-size)", margin: "0" }}>
        <span>Resend in </span>
        <strong style={{ color: "var(--text-base-default)" }}>29 seconds</strong>
      </p>
    </main>
  )
}
