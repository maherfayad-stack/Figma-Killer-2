import styles from './Signup.module.css'

export default function Signup() {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.lede}>
          Fourteen days, one location, no card. Import a stock list on the next screen
          or start counting from empty.
        </p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="signup-name">Full name</label>
          <input className={styles.input} id="signup-name" name="name" type="text" placeholder="Ada Okafor" />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="signup-email">Work email</label>
          <input className={styles.input} id="signup-email" name="email" type="email" placeholder="ada@northwind.co" />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="signup-location">Location name</label>
          <input className={styles.input} id="signup-location" name="location" type="text" placeholder="Dockside warehouse" />
        </div>

        <button className={styles.submit} type="submit">Create account</button>

        <p className={styles.fine}>
          Already counting stock with us? <a className={styles.link} href="/">Sign in</a>
        </p>
      </section>
    </main>
  )
}
