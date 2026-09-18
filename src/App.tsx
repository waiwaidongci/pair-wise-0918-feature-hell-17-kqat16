import "./styles.css";
import AuditLog from "./components/AuditLog";
import EquipmentBoard from "./components/EquipmentBoard";
import Header from "./components/Header";
import OrderQueue from "./components/OrderQueue";
import ScheduleBoard from "./components/ScheduleBoard";

function App() {
  return (
    <main className="app">
      <Header />
      <EquipmentBoard />
      <div className="grid-2col">
        <ScheduleBoard />
        <AuditLog />
      </div>
      <OrderQueue />
      <footer className="foot-note">
        设备状态、工单历史与刷新后的排班由同一份状态派生：任何操作后三者即时一致。
      </footer>
    </main>
  );
}

export default App;
