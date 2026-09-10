import styles from './Page.module.css'

export default function Page() {
  return (
    <main style={{ backgroundImage: "url('/EN.png')",
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
        height: "334px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--btn-px)",
        overflow: "hidden"
    }}>
      <p className={styles.subtitle} style={{ width: "394px",
          textAlign: "center"
    }}>Start editing this page in Studio.</p>
      <div className={styles.maher} style={{ display: "flex", flexDirection: "column",
          width: "213px",
          backgroundColor: "#000000"
    }}>
        <p className="text-ai-background" style={{ textAlign: "center",
            backgroundColor: "#ffffff"
        }}>{"asdasdasd"}</p>
      </div>
    </main>
  )
}
