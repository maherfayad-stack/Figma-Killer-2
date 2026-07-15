function Helper() {
  return (
    <>
      <span>one</span>
      <span>two</span>
    </>
  );
}

export function Fragments() {
  return (
    <div>
      <>
        <p>a</p>
        <p>b</p>
      </>
      <Helper />
    </div>
  );
}
