import { useState, useEffect, useCallback } from 'react';
import NavBar from './components/NavBar/index.jsx';
import Dashboard from './pages/Dashboard/index.jsx';
import Sales from './pages/Sales/index.jsx';
import { getLocations } from './api/index.js';
import styles from './App.module.css';

export default function App() {
  const [locations, setLocations]                   = useState([]);
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [lastSynced, setLastSynced]                 = useState(null);
  const [isRefreshing, setIsRefreshing]             = useState(false);
  const [activeTab, setActiveTab]                   = useState('operations');

  useEffect(() => {
    getLocations().then(setLocations).catch(console.error);
  }, []);

  const handleSyncChange = useCallback((synced, refreshing) => {
    setLastSynced(synced);
    setIsRefreshing(refreshing);
  }, []);

  return (
    <div className={styles.app}>
      <NavBar
        locations={locations}
        selectedLocationId={selectedLocationId}
        onLocationChange={setSelectedLocationId}
        lastSynced={lastSynced}
        isRefreshing={isRefreshing}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <main className={styles.main}>
        {activeTab === 'operations'
          ? <Dashboard locationId={selectedLocationId} onSyncChange={handleSyncChange} />
          : <Sales />
        }
      </main>
    </div>
  );
}
