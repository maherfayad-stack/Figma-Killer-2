import { clsx } from './utils';
export function Frame(props: { active?: boolean }) {
  return (
    <div className={clsx('card p-4', props.active && 'card--active')}>
      <span>x</span>
    </div>
  );
}
