function Helper() {
  return (
    <span>
      <em>helper</em>
    </span>
  );
}

export default function RealFrame() {
  return (
    <div className="real">
      <Helper />
      <p>real content</p>
    </div>
  );
}
