import { cn } from './utils';
export function Frame(props: { active?: boolean }) {
  return (
    <div className={cn('card shadow', props.active && 'card--active')}>
      <span>x</span>
    </div>
  );
}
