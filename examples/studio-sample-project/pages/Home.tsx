import styles from './Home.module.css'

export default function Home() {
  return (
    <main className={styles.page}>
      <header className={styles.nav}>
        <span className={styles.wordmark}>Northwind</span>
        <nav className={styles.links}>
          <a className={styles.link} href="/pricing">Pricing</a>
          <a className={styles.link} href="/signup">Sign up</a>
        </nav>
      </header>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>Inventory, one page</p>
        <h1 className={styles.title}>Know what you have before you sell it.</h1>
        <p className={styles.lede}>
          Northwind keeps stock counts, purchase orders and supplier lead times in one
          place, so the number on the shelf is the number on the screen.
        </p>
        <div className={styles.actions}>
          <a className={styles.primary} href="/signup">Start a trial</a>
          <a className={styles.secondary} href="/pricing">See pricing</a>
        </div>
      </section>

      <section className={styles.features}>
        <article className={styles.feature}>
          <h2 className={styles.featureTitle}>Live counts</h2>
          <p className={styles.featureBody}>
            Every sale, return and stock take moves the same number. No nightly job,
            no reconciliation spreadsheet.
          </p>
        </article>
        <article className={styles.feature}>
          <h2 className={styles.featureTitle}>Reorder points</h2>
          <p className={styles.featureBody}>
            Set a floor per item. Northwind drafts the purchase order when the count
            crosses it and waits for you to send it.
          </p>
        </article>
        <article className={styles.feature}>
          <h2 className={styles.featureTitle}>Supplier lead times</h2>
          <p className={styles.featureBody}>
            Measured from your own order history, not from what the supplier promised
            when you signed up.
          </p>
        </article>
      </section>

      <footer className={styles.footer}>
        <span>Northwind</span>
        <a className={styles.link} href="/pricing">Pricing</a>
      </footer>
    </main>
  )
}
