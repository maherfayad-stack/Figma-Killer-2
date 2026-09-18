import './home.css'

export default function Home() {
  return (
    <main className="home">
      <h1 className="home__title">Vite Live Fixture</h1>
      <p className="home__body">
        One page, so the board has one frame. The point of this project is not what it renders — it is
        that Studio classifies it as a Vite project with a lockfile, and therefore promotes it to
        run-project on first open.
      </p>
      <button className="home__action" type="button">
        Nothing happens
      </button>
    </main>
  )
}
