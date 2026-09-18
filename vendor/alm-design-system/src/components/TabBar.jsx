import './TabBar.css'
import { usePlatform, useDir } from '../context/DesignSystemContext'

// Shared icon + label — identical markup across platforms.
const TabBarItemBody = ({ item }) => (
  <>
    <span className="tabbar__icon-wrap">
      <span className="tabbar__icon">{item.icon}</span>
    </span>
    <span className="tabbar__label">{item.label}</span>
  </>
)

// iOS-only internals — active item gets a sliding selection capsule.
const TabBarItemIOS = ({ item, active }) => (
  <>
    {active && <span className="tabbar__selection" aria-hidden="true" />}
    <TabBarItemBody item={item} />
  </>
)

// Android-only internals — selection is expressed via CSS on the active item.
const TabBarItemAndroid = ({ item }) => <TabBarItemBody item={item} />

// Shared shell — owns the tablist wrapper, pill, and item loop. The per-platform
// render only supplies what goes inside each button.
const TabBarShell = ({ platform, items, value, onChange, dir, className, renderItem, ...props }) => {
  const cls = ['tabbar', `tabbar--${platform}`, className].filter(Boolean).join(' ')

  return (
    <div className={cls} dir={dir} role="tablist" {...props}>
      <div className="tabbar__pill">
        {items.map((item, i) => {
          const active = i === value
          const itemCls = ['tabbar__item', active && 'tabbar__item--active'].filter(Boolean).join(' ')

          return (
            <button
              key={i}
              className={itemCls}
              role="tab"
              aria-selected={active}
              onClick={() => onChange?.(i)}
            >
              {renderItem(item, active)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export const TabBar = ({
  platform,               // ios | android — falls back to provider, then "ios"
  items = [],
  value = 0,
  onChange,
  dir,                    // ltr | rtl — falls back to provider, then "ltr"
  className,
  ...props
}) => {
  const resolvedPlatform = usePlatform(platform)
  const resolvedDir = useDir(dir)

  const renderItem = (item, active) =>
    resolvedPlatform === 'ios' ? (
      <TabBarItemIOS item={item} active={active} />
    ) : (
      <TabBarItemAndroid item={item} />
    )

  return (
    <TabBarShell
      platform={resolvedPlatform}
      items={items}
      value={value}
      onChange={onChange}
      dir={resolvedDir}
      className={className}
      renderItem={renderItem}
      {...props}
    />
  )
}
