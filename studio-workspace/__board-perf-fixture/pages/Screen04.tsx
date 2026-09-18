import './screens.css'

export default function Screen04() {
  return (
    <main className="screen">
      <header className="screen__bar">
        <span className="screen__title">Billing</span>
        <span className="screen__badge">Frame 4 of 12</span>
      </header>

      <section className="panel">
        <h2 className="panel__heading">Billing summary</h2>
        <p className="panel__body">
          Twelve frames of the same shape, laid out two to a row, so that a
          zoom-out crosses a virtualization boundary and mounts frames while the
          gesture is still running.
        </p>
      </section>

      <ul className="tiles">
        <li className="tile">
          <span className="tile__label">Alpha</span>
          <span className="tile__value">38</span>
        </li>
        <li className="tile">
          <span className="tile__label">Bravo</span>
          <span className="tile__value">51</span>
        </li>
        <li className="tile">
          <span className="tile__label">Charlie</span>
          <span className="tile__value">64</span>
        </li>
        <li className="tile">
          <span className="tile__label">Delta</span>
          <span className="tile__value">77</span>
        </li>
        <li className="tile">
          <span className="tile__label">Echo</span>
          <span className="tile__value">90</span>
        </li>
        <li className="tile">
          <span className="tile__label">Foxtrot</span>
          <span className="tile__value">13</span>
        </li>
      </ul>

      <footer className="screen__foot">
        <button className="screen__action" type="button">Continue</button>
      </footer>
    </main>
  )
}
