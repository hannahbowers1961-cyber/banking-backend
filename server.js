require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors()); 
app.use(express.json()); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const resolveUserId = async (identifier) => {
  if (identifier.includes('@')) {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) throw new Error("Failed to search users.");
    const user = users.find(u => u.email === identifier.toLowerCase().trim());
    if (!user) throw new Error("User with this email not found.");
    return user.id;
  }
  return identifier; 
};

app.get('/', (req, res) => res.send('🏦 Bank API Running.'));

// CREATE USER (Now includes Phone & Legal Name logic)
app.post('/api/manager/create-user', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password: password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName, phone: phone }
    });
    if (authError) throw authError;

    const newUserId = authData.user.id;
    const legalName = `${firstName} ${lastName}`.trim(); 

    await supabase.from('profiles').insert([{ 
      id: newUserId, 
      account_status: 'active',
      legal_name: legalName,
      phone: phone 
    }]);
    
    await supabase.from('accounts').insert([{ user_id: newUserId, balance: 0.00, savings_balance: 0.00 }]);

    res.json({ message: `Success! Account created for ${email}. They can now log in.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/manager/toggle-status', async (req, res) => {
  try {
    const { identifier, newStatus } = req.body; 
    const userId = await resolveUserId(identifier);
    const { error } = await supabase.from('profiles').update({ account_status: newStatus }).eq('id', userId);
    if (error) throw error;
    res.json({ message: `Account updated to ${newStatus}` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/manager/inject-funds', async (req, res) => {
  try {
    const { identifier, amount, description } = req.body;
    const userId = await resolveUserId(identifier);
    
    const numAmount = parseFloat(amount);
    const isWithdrawal = numAmount < 0;
    const type = isWithdrawal ? 'withdrawal' : 'deposit';
    const absAmount = Math.abs(numAmount); 
    
    const finalDesc = description ? description : (isWithdrawal ? 'Manual Withdrawal' : 'Manual Deposit');

    const { data: account, error: fetchError } = await supabase.from('accounts').select('balance').eq('user_id', userId).single();
    if (fetchError) throw fetchError;

    const newBalance = parseFloat(account.balance) + numAmount;
    await supabase.from('accounts').update({ balance: newBalance }).eq('user_id', userId);
    
    await supabase.from('transactions').insert([{
      user_id: userId, type: type, amount: absAmount, status: 'approved', description: finalDesc
    }]);

    res.json({ message: `Success! ${isWithdrawal ? 'Withdrew' : 'Deposited'} $${absAmount}.` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/client/transfer', async (req, res) => {
  try {
    const { userId, amount, direction } = req.body; 
    const numAmount = parseFloat(amount);
    const { data: acc } = await supabase.from('accounts').select('balance, savings_balance').eq('user_id', userId).single();

    let newChecking = parseFloat(acc.balance);
    let newSavings = parseFloat(acc.savings_balance || 0);
    let transferDesc = '';

    if (direction === 'c2s') {
       newChecking -= numAmount; newSavings += numAmount; transferDesc = "Transfer to Savings";
    } else {
       newChecking += numAmount; newSavings -= numAmount; transferDesc = "Transfer to Checking";
    }

    await supabase.from('accounts').update({ balance: newChecking, savings_balance: newSavings }).eq('user_id', userId);
    await supabase.from('transactions').insert([{ user_id: userId, type: 'transfer', amount: numAmount, status: 'approved', description: transferDesc }]);

    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🏦 Server alive on http://localhost:${PORT}`));