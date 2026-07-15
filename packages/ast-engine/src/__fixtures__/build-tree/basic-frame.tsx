import { Button } from 'design-system';
import { Helper } from './helper';

export default function BasicFrame() {
  return (
    <section className="frame">
      <h1>Title</h1>
      <p>
        Some text with <span>inline</span> content.
      </p>
      <img src="/a.png" alt="a" />
      <Button label="Click" />
      <Helper />
    </section>
  );
}
