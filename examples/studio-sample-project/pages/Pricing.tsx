import styles from './Pricing.module.css'

export default function Pricing() {
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Pricing</h1>
        <p className={styles.lede}>
          Billed per location. Every plan counts stock in real time; the plans differ
          in how many people and suppliers you can put on it.
        </p>
      </header>

      <section className={styles.plans}>
        <article className={styles.plan}>
          <h2 className={styles.planName}>Counter</h2>
          <p className={styles.price}>
            $29<span className={styles.period}>/month</span>
          </p>
          <ul className={styles.list}>
            <li className={styles.item}>One location</li>
            <li className={styles.item}>Two users</li>
            <li className={styles.item}>Reorder points</li>
          </ul>
          <a className={styles.secondary} href="/signup">Choose Counter</a>
        </article>

        <article className={styles.planFeatured}>
          <p className={styles.badge}>Most chosen</p>
          <h2 className={styles.planName}>Warehouse</h2>
          <p className={styles.price}>
            $89<span className={styles.period}>/month</span>
          </p>
          <ul className={styles.list}>
            <li className={styles.item}>Five locations</li>
            <li className={styles.item}>Ten users</li>
            <li className={styles.item}>Supplier lead times</li>
            <li className={styles.item}>Purchase order drafts</li>
          </ul>
          <a className={styles.primary} href="/signup">Choose Warehouse</a>
        </article>

        <article className={styles.plan}>
          <h2 className={styles.planName}>Network</h2>
          <p className={styles.price}>
            $240<span className={styles.period}>/month</span>
          </p>
          <ul className={styles.list}>
            <li className={styles.item}>Unlimited locations</li>
            <li className={styles.item}>Unlimited users</li>
            <li className={styles.item}>Transfer orders between sites</li>
          </ul>
          <a className={styles.secondary} href="/signup">Choose Network</a>
        </article>
      </section>

      <footer className={styles.footer}>
        <a className={styles.link} href="/">Back to home</a>
      </footer>
    </main>
  )
}
