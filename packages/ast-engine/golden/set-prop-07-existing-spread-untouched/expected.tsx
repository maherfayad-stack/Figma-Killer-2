export function Frame(props: { rest?: Record<string, unknown> }) {
  return (
    <div>
      <button {...props.rest} title="Click me">
        Go
      </button>
    </div>
  );
}
