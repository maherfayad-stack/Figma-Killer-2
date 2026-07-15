export function First() {
  return <div className="first">First</div>;
}

export function Second() {
  return (
    <section>
      <First />
      <p>Second body</p>
    </section>
  );
}

export const Third = () => <span>third</span>;
