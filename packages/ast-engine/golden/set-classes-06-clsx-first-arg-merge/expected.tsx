import { clsx } from './utils';
export function Frame(props: { active?: boolean }) {
  return (
    <div className={clsx('card p-4 gap-2', props.active && 'card--active')}>
      <span>x</span>
    </div>
  );
}
