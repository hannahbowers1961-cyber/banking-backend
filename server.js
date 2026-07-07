require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors()); 
app.use(express.json()); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// --- BROWSER TEST ROUTE ---
app.get('/', (req, res) => {
  res.send('🏦 Bank API Running perfectly.');
});

// --- MANAGER ROUTES ---
app.post('/api/manager/toggle-status', async (req, res) => {
  const { userId, newStatus } = req.body; 
  const { error } = await supabase.from('profiles').update({ account_status: newStatus }).eq('id', userId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: `Account updated to ${newStatus}` });
});

// UPGRADED: Now handles Deposits (+) and Withdrawals (-)
app.post('/api/manager/inject-funds', async (req, res) => {
  const { userId, amount } = req.body;
  
  // Detect if there is a minus sign
  const numAmount = parseFloat(amount);
  const isWithdrawal = numAmount < 0;
  const type = isWithdrawal ? 'withdrawal' : 'deposit';
  const absAmount = Math.abs(numAmount); // Strip the minus sign for the transaction log

  const { data: account, error: fetchError } = await supabase
    .from('accounts').select('balance').eq('user_id', userId).single();

  if (fetchError) return res.status(400).json({ error: fetchError.message });

  // If numAmount is negative, this automatically subtracts it!
  const newBalance = parseFloat(account.balance) + numAmount;

  await supabase.from('accounts').update({ balance: newBalance }).eq('user_id', userId);
  
  await supabase.from('transactions').insert([{
    user_id: userId, type: type, amount: absAmount, status: 'approved'
  }]);

  res.json({ message: `Success! ${isWithdrawal ? 'Withdrew' : 'Deposited'} $${absAmount}. Checking Balance: $${newBalance}` });
});

// --- NEW CLIENT ROUTE: TRANSFER MONEY ---
app.post('/api/client/transfer', async (req, res) => {
  const { userId, amount, direction } = req.body; // direction is 'c2s' or 's2c'
  const numAmount = parseFloat(amount);

  // Fetch both balances
  const { data: acc } = await supabase
    .from('accounts').select('balance, savings_balance').eq('user_id', userId).single();

  let newChecking = parseFloat(acc.balance);
  let newSavings = parseFloat(acc.savings_balance || 0);

  // Move the money based on the direction they chose
  if (direction === 'c2s') {
     newChecking -= numAmount; // Deduct from Checking
     newSavings += numAmount;  // Add to Savings
  } else {
     newChecking += numAmount; // Add to Checking
     newSavings -= numAmount;  // Deduct from Savings
  }

  // Save to database
  await supabase.from('accounts')
    .update({ balance: newChecking, savings_balance: newSavings }).eq('user_id', userId);

  // Log the transfer
  await supabase.from('transactions').insert([{
    user_id: userId, type: 'transfer', amount: numAmount, status: 'approved'
  }]);

  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🏦 Server alive on http://localhost:${PORT}`));