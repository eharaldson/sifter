const DebugTest = () => {
  console.log("🧪 DebugTest component rendering");
  
  return (
    <div style={{ 
      padding: '20px', 
      backgroundColor: 'red', 
      color: 'white', 
      fontSize: '24px',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <div>
        <h1>DEBUG TEST - If you see this, React is working!</h1>
        <p>Current time: {new Date().toISOString()}</p>
      </div>
    </div>
  );
};

export default DebugTest;
