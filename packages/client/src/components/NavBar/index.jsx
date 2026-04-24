import styles from './index.module.css';

function fmtTime(ts) {
  if (!ts) return null;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ts));
}

export default function NavBar({
  locations,
  selectedLocationId,
  onLocationChange,
  lastSynced,
  isRefreshing,
  activeTab,
  onTabChange,
}) {
  return (
    <nav className={styles.nav}>
      <div className={styles.logo}>HURACAN</div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'operations' ? styles.tabActive : ''}`}
          onClick={() => onTabChange('operations')}
        >
          Operations
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'sales' ? styles.tabActive : ''}`}
          onClick={() => onTabChange('sales')}
        >
          Sales
        </button>
      </div>

      {activeTab === 'operations' && (
        <div className={styles.filters}>
          <button
            className={`${styles.btn} ${selectedLocationId === null ? styles.active : ''}`}
            onClick={() => onLocationChange(null)}
          >
            All Locations
          </button>
          {locations.map((loc) => (
            <button
              key={loc.id}
              className={`${styles.btn} ${selectedLocationId === loc.id ? styles.active : ''}`}
              onClick={() => onLocationChange(loc.id)}
            >
              {loc.city}
            </button>
          ))}
        </div>
      )}

      <div className={styles.sync}>
        {activeTab === 'operations' && (
          isRefreshing
            ? <span className={styles.refreshing}>Refreshing…</span>
            : lastSynced
              ? <span className={styles.synced}>Synced {fmtTime(lastSynced)}</span>
              : null
        )}
      </div>
    </nav>
  );
}
