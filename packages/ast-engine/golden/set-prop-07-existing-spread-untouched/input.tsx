export function Frame(props: { rest?: Record<string, unknown> }) {
  return (
    <div>
      <button {...props.rest}>Go</button>
    </div>
  );
}
