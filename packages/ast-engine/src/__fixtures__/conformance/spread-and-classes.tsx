import { cn } from './utils';

export function Card(props: { active?: boolean; rest?: Record<string, unknown> }) {
  return (
    <div className={cn('card', props.active && 'card--active')} {...props.rest}>
      <header className="card__header">Header</header>
      <div className="card__body">
        <p>Body</p>
      </div>
    </div>
  );
}
